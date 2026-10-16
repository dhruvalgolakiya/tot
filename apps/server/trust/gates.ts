import { randomUUID } from "node:crypto";
import type { GateName, GateReport, GateResult, RepoProfileInput } from "../../shared/types.ts";
import type { FolderGrant } from "../computer/types.ts";
import { db, parseJson, type Row } from "../db.ts";
import { checkScope, type Plan } from "./scope.ts";
import { exec, folderArg, output, repoState, sections, sh, stripAnsi, tail } from "./shell.ts";

/**
 * Gates: checks with a pass/fail result that prove work instead of taking the
 * agent's word for it. Command gates run the repo's own commands (from its
 * profile) in the branch's folder. When one fails, the same command runs on the
 * base commit, in a throwaway git worktree, so a failure that was already there
 * doesn't block — only failures the base doesn't have do. Base results are
 * cached by commit, so that happens once per base.
 */

export const COMMAND_GATES = ["typecheck", "lint", "test", "build", "e2e"] as const;
type CommandGate = (typeof COMMAND_GATES)[number];
const GATE_ORDER: GateName[] = [...COMMAND_GATES, "repro", "scope", "deps", "size", "review"];

const isCommandGate = (gate: GateName): gate is CommandGate => (COMMAND_GATES as readonly string[]).includes(gate);

export interface GateRun {
  agentId: string;
  /** The repo's folder on the agent's computer, relative to its home. */
  cwd: string;
  profile: RepoProfileInput;
  /** The repo's brain, which base results are cached under; without one, the folder is. */
  brainId?: string | null;
  gates: GateName[];
  baseRef: string;
  plan?: Plan;
  /** Read-only work: any change fails the scope gate. */
  readOnly?: boolean;
  /** The reproduce step's failing test or script: it must fail before the fix and pass after it. */
  repro?: { command: string; expect: "fail" | "pass" };
  /**
   * A task's folder grant, when its worktree is in a folder project on this Mac (module 09). The
   * sandbox lets it write that worktree only, so base results can't be made there (no comparison).
   */
  grant?: FolderGrant | null;
}

/** A failure blocks unless the base branch fails the same way. Anything waiting for the user's OK blocks too. */
export function blocks(result: GateResult): boolean {
  if (result.status === "needs-approval") return true;
  return result.status === "fail" && !(result.baseline === "fail" && result.newFailures?.length === 0);
}

// ---------------------------------------------------------------------------
// Telling failures apart

/** Lines that read like a failure: test runners, compilers and linters all say one of these. */
const FAILURE_LINE = /\b(?:fail(?:s|ed|ing|ure|ures)?|errors?|not ok|panic(?:ked)?|exception)\b|[✕✗✖×]/i;

/** One output line without what changes from run to run: folders, line numbers, timings, counts, addresses. */
function normalize(line: string, dirs: string[]): string {
  let out = line;
  for (const dir of dirs) out = out.split(dir).join("<repo>");
  return out
    .replace(/file:\/\//g, "")
    .replace(/\(\d+(?:\.\d+)?\s*m?s\)|\b\d+(?:\.\d+)?\s*m?s\b/g, "")
    .replace(/:\d+(?::\d+)?\b/g, "")
    .replace(/\(\d+,\d+\)/g, "")
    .replace(/\b0x[0-9a-f]+\b/gi, "")
    .replace(/\b\d+(?:\.\d+)?\b/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The normalized failure lines of some output, to compare one run with another. When nothing reads like
 * a failure, the last lines stand in, so two failing runs still compare by what they printed.
 */
export function failureLines(text: string, dirs: string[] = []): string[] {
  // A folder can show up as /private/var/… or /var/… on macOS: match both.
  const variants = [...new Set(dirs.filter(Boolean).flatMap((dir) => [dir, dir.replace(/^\/private(?=\/)/, "")]))].sort((a, b) => b.length - a.length);
  const lines = stripAnsi(text)
    .split("\n")
    .map((line) => normalize(line, variants))
    .filter(Boolean);
  const failing = [...new Set(lines.filter((line) => FAILURE_LINE.test(line)))];
  return (failing.length ? failing : lines.slice(-20)).slice(0, 300);
}

// ---------------------------------------------------------------------------
// Base results, cached by (repo, base commit, gate, command)

interface Baseline {
  status: "pass" | "fail";
  failures: string[];
}

function cachedBaseline(scope: string, baseSha: string, gate: CommandGate, command: string): Baseline | null {
  const row = db.prepare(`SELECT status, failures FROM gate_baselines WHERE scope = ? AND base_sha = ? AND gate = ? AND command = ?`).get(scope, baseSha, gate, command) as
    | Row
    | undefined;
  return row ? { status: row.status === "pass" ? "pass" : "fail", failures: parseJson<string[]>(row.failures, []) } : null;
}

/** Runs the given gates on the base commit in a throwaway worktree (installing first), caching each result. */
async function runOnBase(run: GateRun, scope: string, baseSha: string, gates: CommandGate[], timeoutMs: number): Promise<Map<CommandGate, Baseline>> {
  const found = new Map<CommandGate, Baseline>();
  const todo: CommandGate[] = [];
  for (const gate of gates) {
    const cached = cachedBaseline(scope, baseSha, gate, run.profile.commands[gate]!);
    if (cached) found.set(gate, cached);
    else todo.push(gate);
  }
  if (!todo.length) return found;

  const name = `.tot-baselines/${baseSha.slice(0, 12)}-${randomUUID().slice(0, 8)}`;
  const made = await sections(
    run.agentId,
    `mkdir -p .tot-baselines && git -C ${folderArg(run.cwd)} worktree add --detach "$PWD/${name}" ${sh(baseSha)} >/dev/null 2>&1 && cd ${sh(name)} && echo "@@@ dir" && pwd -P`,
    undefined,
    run.grant,
  );
  const dir = made.dir?.trim();
  if (!dir) return found;
  try {
    if (run.profile.commands.install) await exec(run.agentId, run.profile.commands.install, { cwd: dir, timeoutMs, grant: run.grant });
    for (const gate of todo) {
      const command = run.profile.commands[gate]!;
      const result = await exec(run.agentId, command, { cwd: dir, timeoutMs, grant: run.grant });
      const baseline: Baseline = { status: result.exitCode === 0 ? "pass" : "fail", failures: result.exitCode === 0 ? [] : failureLines(output(result), [dir]) };
      db.prepare(
        `INSERT INTO gate_baselines (scope, base_sha, gate, command, status, failures, output_tail, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(scope, base_sha, gate, command) DO UPDATE SET status = excluded.status, failures = excluded.failures, output_tail = excluded.output_tail, created_at = excluded.created_at`,
      ).run(scope, baseSha, gate, command, baseline.status, JSON.stringify(baseline.failures), tail(output(result)), Date.now());
      found.set(gate, baseline);
    }
  } finally {
    await exec(run.agentId, `git -C ${folderArg(run.cwd)} worktree remove --force ${sh(dir)} >/dev/null 2>&1; rm -rf ${sh(dir)}; git -C ${folderArg(run.cwd)} worktree prune`, {
      timeoutMs: 60_000,
      grant: run.grant,
    }).catch(() => {});
  }
  return found;
}

/** Runs every command gate on the base commit now (cached), so a task knows up front which checks already fail there. */
export async function baseline(run: Omit<GateRun, "gates">): Promise<{ baseSha: string; results: Partial<Record<CommandGate, Baseline>> }> {
  const { baseSha } = await repoState(run.agentId, run.cwd, run.baseRef, run.grant);
  const gates = COMMAND_GATES.filter((gate) => run.profile.commands[gate]);
  const timeoutMs = run.profile.limits.commandTimeoutMinutes * 60_000;
  const found = await runOnBase({ ...run, gates: [] }, scopeOf(run), baseSha, gates, timeoutMs);
  return { baseSha, results: Object.fromEntries(found) };
}

const scopeOf = (run: Pick<GateRun, "brainId" | "agentId" | "cwd">) => run.brainId || `${run.agentId}:${run.cwd.replace(/^~\/?/, "")}`;

// ---------------------------------------------------------------------------

const LABEL: Record<CommandGate, string> = { typecheck: "typecheck", lint: "lint", test: "test", build: "build", e2e: "end-to-end" };

export async function runGates(run: GateRun): Promise<GateReport> {
  const { headSha, baseSha } = await repoState(run.agentId, run.cwd, run.baseRef, run.grant);
  const cwd = run.cwd.replace(/^~\/?/, "") || ".";
  const timeoutMs = run.profile.limits.commandTimeoutMinutes * 60_000;
  const wanted = GATE_ORDER.filter((gate) => run.gates.includes(gate));
  const results: GateResult[] = [];
  const dir = (await sections(run.agentId, `echo "@@@ dir"; pwd -P`, cwd, run.grant)).dir?.trim() ?? "";

  // The branch first; then, only for what failed, the base commit to compare with.
  const failed: { gate: CommandGate; result: GateResult; failures: string[] }[] = [];
  for (const gate of wanted.filter(isCommandGate)) {
    const command = run.profile.commands[gate];
    if (!command) {
      results.push({ gate, status: "skipped", note: `No ${LABEL[gate]} command in the repo profile.` });
      continue;
    }
    const ran = await exec(run.agentId, command, { cwd, timeoutMs, grant: run.grant });
    const result: GateResult = {
      gate,
      status: ran.exitCode === 0 ? "pass" : "fail",
      command,
      exitCode: ran.exitCode,
      outputTail: tail(output(ran)),
      durationMs: ran.durationMs,
      ...(ran.timedOut ? { note: `Timed out after ${run.profile.limits.commandTimeoutMinutes} min.` } : {}),
    };
    results.push(result);
    if (result.status === "fail") failed.push({ gate, result, failures: failureLines(output(ran), [dir]) });
  }
  if (failed.length) {
    const base = await runOnBase(
      run,
      scopeOf(run),
      baseSha,
      failed.map((item) => item.gate),
      timeoutMs,
    );
    for (const { gate, result, failures } of failed) {
      const known = base.get(gate);
      if (!known) {
        result.note = [result.note, "Couldn't run it on the base branch to compare."].filter(Boolean).join(" ");
        continue;
      }
      result.baseline = known.status;
      if (known.status === "pass") {
        result.note = [result.note, "Passes on the base branch, so this branch broke it."].filter(Boolean).join(" ");
        continue;
      }
      const before = new Set(known.failures);
      result.newFailures = failures.filter((line) => !before.has(line)).slice(0, 50);
      result.note = result.newFailures.length
        ? `Fails on the base branch too, but ${result.newFailures.length === 1 ? "this failure is" : "these failures are"} new.`
        : "Fails the same way on the base branch, so it doesn't block.";
    }
  }

  if (wanted.includes("repro")) {
    if (!run.repro) {
      results.push({ gate: "repro", status: "skipped", note: "Nothing reproduces the bug yet." });
    } else {
      const ran = await exec(run.agentId, run.repro.command, { cwd, timeoutMs, grant: run.grant });
      const fails = ran.exitCode !== 0;
      const ok = run.repro.expect === "fail" ? fails : !fails;
      results.push({
        gate: "repro",
        status: ok ? "pass" : "fail",
        command: run.repro.command,
        exitCode: ran.exitCode,
        outputTail: tail(output(ran)),
        durationMs: ran.durationMs,
        note:
          run.repro.expect === "fail"
            ? ok
              ? "Reproduces the bug: it fails before the fix."
              : "Doesn't reproduce the bug: it passes without a fix."
            : ok
              ? "Passes now that the bug is fixed."
              : "Still fails after the fix.",
      });
    }
  }

  if (wanted.some((gate) => gate === "scope" || gate === "deps" || gate === "size")) {
    const scoped = await checkScope({ agentId: run.agentId, cwd, baseSha, profile: run.profile, plan: run.plan, readOnly: run.readOnly, grant: run.grant });
    for (const result of scoped) {
      if (result.gate === "test") {
        // Skipped or deleted tests make a passing test run meaningless: it needs the user's OK.
        const test = results.find((r) => r.gate === "test");
        if (!test || test.status === "skipped") results.splice(test ? results.indexOf(test) : results.length, test ? 1 : 0, result);
        else {
          if (!blocks(test)) test.status = "needs-approval";
          test.note = [test.note, result.note].filter(Boolean).join(" ");
          test.details = result.details;
        }
      } else if (wanted.includes(result.gate)) {
        results.push(result);
      }
    }
  }

  results.sort((a, b) => GATE_ORDER.indexOf(a.gate) - GATE_ORDER.indexOf(b.gate));
  return { ok: !results.some(blocks), results, at: Date.now(), headSha, baseSha };
}
