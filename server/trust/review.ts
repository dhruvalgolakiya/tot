import { z } from "zod";
import type { GateReport, ProviderId, RepoProfileInput, Review, ReviewFinding } from "../../shared/types.ts";
import { HttpError } from "../agent/orchestrator.ts";
import { jsonIn, trustModel, type Answer } from "./model.ts";
import { repoState, sections, sh } from "./shell.ts";
import { workflows } from "./settings.ts";

/**
 * The independent review: a fresh model, on the other provider from the one that
 * wrote the code unless the user picked one, sees only the plan, the diff, the
 * repo's conventions and the latest checks — never the transcript of the work —
 * and returns a structured verdict. A tool-less one-shot call, so it can't go
 * looking around the repo: what it needs to judge "does this function exist?"
 * is put in front of it (calls that appear nowhere else in the repo).
 */

/** Big diffs are reviewed in parts of about this many characters, split between files. */
const CHUNK_CHARS = 60_000;
const MAX_SYMBOLS = 40;

export interface ReviewRequest {
  agentId: string;
  cwd: string;
  baseRef: string;
  profile: RepoProfileInput;
  plan?: string;
  /** Who wrote the code: the reviewer is the other provider unless Settings → Workflows picks one. */
  implementedBy?: ProviderId;
  /** The latest checks, so the reviewer knows what already passed or failed. */
  gates?: GateReport;
}

const Finding = z.object({
  file: z.string().min(1),
  line: z.number().int().positive().nullish(),
  severity: z.enum(["must-fix", "should-fix", "nit"]),
  issue: z.string().min(1),
  suggestion: z.string().nullish(),
});
const Verdict = z.object({
  verdict: z.enum(["approve", "changes-requested"]),
  summary: z.string().min(1),
  findings: z.array(Finding).max(50),
});

// ---------------------------------------------------------------------------
// Reading the diff

/**
 * Each hunk line gets the new file's line number, so findings can point at lines without
 * the model counting from @@ headers. Removed lines get no number.
 */
export function numberDiff(diff: string): string {
  let line = 0;
  let inHunk = false;
  return diff
    .split("\n")
    .map((text) => {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
      if (hunk) {
        line = Number(hunk[1]);
        inHunk = true;
        return text;
      }
      if (text.startsWith("diff --git ")) inHunk = false;
      if (!inHunk || text.startsWith("\\")) return text;
      if (text.startsWith("-")) return `      ${text}`;
      return `${String(line++).padStart(5)} ${text}`;
    })
    .join("\n");
}

/** A diff split between files into parts of at most `size` characters; a file bigger than that is cut short. */
export function chunkDiff(diff: string, size = CHUNK_CHARS): string[] {
  const files = diff.split(/(?=^diff --git )/m).filter((part) => part.trim());
  const chunks: string[] = [];
  let current = "";
  for (const file of files) {
    const part = file.length > size ? `${file.slice(0, size)}\n[… ${file.length - size} more characters of this file's diff not shown]\n` : file;
    if (current && current.length + part.length > size) {
      chunks.push(current);
      current = "";
    }
    current += part;
  }
  if (current) chunks.push(current);
  return chunks;
}

const KEYWORDS = new Set(
  "if for while switch catch return function typeof new await async super import require constructor elif def func print len range str int float list dict set tuple isinstance self this".split(
    " ",
  ),
);
const DEFINITIONS = [
  /\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g,
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g,
  /\b(?:def|class|func|fn|interface|type)\s+([A-Za-z_$][\w$]*)/g,
  /^\s*(?:(?:public|private|protected|static|async|override|export)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{=]*)?\{\s*$/gm,
];
const CALL = /(?:^|[^\w$])([A-Za-z_$][\w$]*)\s*\(/g;

/** Names the diff calls (where first, and on how many added lines), minus keywords and what the diff itself defines. */
export function calledNames(diff: string): Map<string, { file: string; count: number }> {
  const calls = new Map<string, { file: string; count: number }>();
  const defined = new Set<string>();
  let file = "";
  for (const line of diff.split("\n")) {
    const header = /^\+\+\+ (?:b\/)?(.+)$/.exec(line);
    if (header) {
      file = header[1];
      continue;
    }
    if (!line.startsWith("+")) continue;
    const code = line.slice(1).replace(/\/\/.*$|#.*$/, "").replace(/(["'`])(?:\\.|(?!\1).)*\1/g, '""');
    for (const pattern of DEFINITIONS) for (const match of code.matchAll(pattern)) defined.add(match[1]);
    // Counted once per line, like git grep -c counts lines.
    for (const name of new Set([...code.matchAll(CALL)].map((match) => match[1]))) {
      if (KEYWORDS.has(name) || name.length < 3) continue;
      const seen = calls.get(name);
      calls.set(name, { file: seen?.file ?? file, count: (seen?.count ?? 0) + 1 });
    }
  }
  for (const name of defined) calls.delete(name);
  return calls;
}

/** Calls in the diff that appear nowhere else in the repo — library APIs, or invented ones. */
async function unknownCalls(agentId: string, cwd: string, diff: string): Promise<string[]> {
  const calls = [...calledNames(diff)].slice(0, MAX_SYMBOLS);
  if (!calls.length) return [];
  const found = await sections(
    agentId,
    `echo "@@@ counts"; for n in ${calls.map(([name]) => sh(name)).join(" ")}; do printf '%s %s\\n' "$n" "$(git grep --untracked -I -F -w -c -e "$n" -- . 2>/dev/null | awk -F: '{s+=$NF} END {print s+0}')"; done`,
    cwd,
  );
  const counts = new Map((found.counts ?? "").split("\n").filter(Boolean).map((line) => line.split(" ") as [string, string]));
  // Lines in the repo that mention it vs. added lines that call it: no more mentions than calls means nowhere else.
  return calls.filter(([name, { count }]) => Number(counts.get(name) ?? 0) <= count).map(([name, { file }]) => `${name}() in ${file}`);
}

async function readChanges(agentId: string, cwd: string, baseSha: string): Promise<string> {
  const base = sh(baseSha);
  const found = await sections(
    agentId,
    `echo "@@@ diff"; git diff -U8 --no-color --no-ext-diff -M ${base} -- . ':(exclude)*.lock' ':(exclude)*-lock.json' ':(exclude)*-lock.yaml' | head -c 600000; echo
echo "@@@ untracked"; git ls-files --others --exclude-standard | head -30 | while IFS= read -r f; do [ "$(wc -c < "$f")" -lt 100000 ] && git diff --no-index -U8 --no-color /dev/null "$f"; done | head -c 200000; echo`,
    cwd,
  );
  return [found.diff ?? "", found.untracked ?? ""].map((part) => part.trim()).filter(Boolean).join("\n");
}

// ---------------------------------------------------------------------------
// Asking

const SYSTEM =
  "You are an independent code reviewer. You didn't write this change and have no stake in it: your job is to find what's wrong before it ships. Report only real problems you can point to in the diff — no praise, no generic advice. Reply with JSON only.";

const GATE_WORDS = { pass: "passed", fail: "failed", skipped: "skipped", "needs-approval": "waiting for the user's OK" } as const;

function prompt(req: ReviewRequest, where: string, unknown: string[], diff: string, part: { index: number; total: number }): string {
  const list = (items: string[], empty: string) => (items.length ? items.map((item) => `- ${item}`).join("\n") : empty);
  const gates = req.gates?.results.map((r) => `- ${r.gate}: ${GATE_WORDS[r.status]}${r.note ? ` — ${r.note}` : ""}`).join("\n");
  return `Review this change to ${where}.

## What it was meant to do (the plan)
${req.plan?.trim() || "No plan was given: judge the change on its own."}

## This repo's conventions
${list(req.profile.conventions, "None recorded.")}

## Its definition of done
${list(req.profile.definitionOfDone, "None recorded.")}
${gates ? `\n## Checks already run on it\n${gates}\n` : ""}
## Calls in the diff that appear nowhere else in the repo and aren't defined in the diff
${list(unknown, "None.")}
(Each is either an API of a library the repo uses — fine — or doesn't exist, which is a must-fix.)

## The diff${part.total > 1 ? ` (part ${part.index} of ${part.total}; review this part only)` : ""}
Lines are numbered as in the new file.
\`\`\`diff
${diff}
\`\`\`

## Check, in this order
1. Correctness: logic errors, off-by-one and boundary mistakes, wrong conditions, null/undefined handling, error handling, races, leaks.
2. Invented or misused APIs: every function, method, type, import, option and flag the diff uses must exist with that signature, in this repo or in a library it uses. Calling something that doesn't exist is a must-fix.
3. The plan: does the change do what the plan says, and nothing unrelated?
4. Tests: is the new behaviour tested? Were tests weakened, skipped or deleted?
5. The conventions above.
6. Security: secrets in code, injection, unsafe handling of input.

Severity: "must-fix" = wrong behaviour, a crash, an invented or misused API, a security hole, weakened tests. "should-fix" = robustness, maintainability, a missing test. "nit" = style.
Verdict: "changes-requested" when there's any must-fix, otherwise "approve".

Reply with only this JSON:
{"verdict": "approve" | "changes-requested", "summary": "<2–4 sentences>", "findings": [{"file": "<path>", "line": <line number in the new file, or leave it out>, "severity": "must-fix" | "should-fix" | "nit", "issue": "<what's wrong>", "suggestion": "<how to fix it, optional>"}]}`;
}

/** Asks once and, when the answer isn't valid, once more with the reason. */
async function ask(text: string, prefer: ProviderId | undefined): Promise<{ verdict: z.infer<typeof Verdict>; answer: Answer }> {
  let answer = await trustModel.ask({ prompt: text, system: SYSTEM, heavy: true, prefer });
  for (let attempt = 0; ; attempt++) {
    let problem: string;
    try {
      const parsed = Verdict.safeParse(jsonIn(answer.text));
      if (parsed.success) return { verdict: parsed.data, answer };
      problem = z.prettifyError(parsed.error);
    } catch (err) {
      problem = err instanceof Error ? err.message : String(err);
    }
    if (attempt === 1) throw new Error(`The reviewer's answer wasn't valid twice (${problem.replace(/\s+/g, " ").slice(0, 200)}).`);
    answer = await trustModel.ask({
      prompt: `${text}\n\nYour previous reply didn't match that format (${problem.replace(/\s+/g, " ").slice(0, 300)}):\n${answer.text.slice(0, 2000)}\n\nReply again with only the JSON object.`,
      system: SYSTEM,
      heavy: true,
      prefer: answer.provider,
    });
  }
}

export async function reviewDiff(req: ReviewRequest): Promise<Review> {
  const cwd = req.cwd.replace(/^~\/?/, "") || ".";
  const { headSha, baseSha } = await repoState(req.agentId, cwd, req.baseRef);
  const diff = await readChanges(req.agentId, cwd, baseSha);
  if (!diff) throw new HttpError(400, `There are no changes against ${req.baseRef} to review.`);
  const unknown = await unknownCalls(req.agentId, cwd, diff);
  const chunks = chunkDiff(numberDiff(diff));
  const where = `${cwd} (${headSha ? headSha.slice(0, 7) : "uncommitted work"} against ${req.baseRef} at ${baseSha.slice(0, 7)})`;

  const prefer = workflows.reviewerFor(req.implementedBy);
  const findings: ReviewFinding[] = [];
  const summaries: string[] = [];
  let changes = false;
  let reviewer: Answer | null = null;
  for (const [index, chunk] of chunks.entries()) {
    const { verdict, answer } = await ask(prompt(req, where, unknown, chunk, { index: index + 1, total: chunks.length }), reviewer?.provider ?? prefer);
    reviewer = answer;
    changes ||= verdict.verdict === "changes-requested";
    summaries.push(verdict.summary.trim());
    for (const finding of verdict.findings) {
      const clean: ReviewFinding = {
        file: finding.file.trim().replace(/^[ab]\//, ""),
        severity: finding.severity,
        issue: finding.issue.trim(),
        ...(finding.line ? { line: finding.line } : {}),
        ...(finding.suggestion?.trim() ? { suggestion: finding.suggestion.trim() } : {}),
      };
      if (!findings.some((other) => other.file === clean.file && other.line === clean.line && other.issue === clean.issue)) findings.push(clean);
    }
  }
  const order = { "must-fix": 0, "should-fix": 1, nit: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return {
    // A must-fix always means changes are needed, whatever the verdict said.
    verdict: changes || findings.some((finding) => finding.severity === "must-fix") ? "changes-requested" : "approve",
    findings,
    summary: summaries.join(" "),
    reviewer: { provider: reviewer!.provider, model: reviewer!.model },
  };
}
