import { HttpError } from "../agent/orchestrator.ts";
import { computerManager } from "../computer/manager.ts";
import type { ExecResult } from "../computer/types.ts";
import { getSecret, secretValues } from "../config.ts";
import { redactGitHubTokens } from "../github.ts";
import { SECRET_SHAPES } from "./secrets.ts";

/**
 * Commands that checks run on an agent's computer: the same exec path as the
 * computer_exec tool, with output scrubbed of secrets before anyone sees or
 * stores it. Folders are relative to the computer's home, like the tool's `cwd`.
 */

/** How much output a gate keeps. */
export const TAIL_BYTES = 4096;
export const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/** Hides every secret TOT holds (GitHub tokens, API keys, mailbox passwords) and anything shaped like a key. */
export function scrub(text: string): string {
  let out = redactGitHubTokens(text);
  for (const secret of [...secretValues(""), getSecret("anthropicApiKey"), getSecret("boatApiKey")]) {
    if (secret && secret.length >= 8) out = out.split(secret).join("[secret hidden]");
  }
  // Token shapes are worth hiding even when TOT doesn't hold the token itself.
  for (const shape of SECRET_SHAPES) out = out.replace(shape, "[secret hidden]");
  return out;
}

export const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");

/** The end of some output, cut at a line boundary. */
export function tail(text: string, limit = TAIL_BYTES): string {
  const clean = stripAnsi(text).replace(/^\s*\n/, "").trimEnd();
  if (clean.length <= limit) return clean;
  const cut = clean.slice(-limit);
  const newline = cut.indexOf("\n");
  return `…\n${newline >= 0 && newline < 200 ? cut.slice(newline + 1) : cut}`;
}

/** Single-quotes a value for bash. */
export const sh = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** Runs a command on the agent's computer; stdout and stderr come back scrubbed. */
export async function exec(agentId: string, command: string, opts: { cwd?: string; timeoutMs?: number } = {}): Promise<ExecResult> {
  const active = await computerManager.ensure(agentId);
  const result = await active.backend.exec(active.externalId, command, { cwd: opts.cwd, timeoutMs: opts.timeoutMs ?? 60_000 });
  computerManager.touch(agentId);
  return { ...result, stdout: scrub(result.stdout), stderr: scrub(result.stderr) };
}

/** stdout and stderr as one text, the way a person reads a failing command. */
export const output = (result: ExecResult) => [result.stdout.trimEnd(), result.stderr.trimEnd()].filter(Boolean).join("\n");

/** A folder as bash should see it: "~/repos/web" and "repos/web" both mean the home's repos/web. */
export const folderArg = (folder: string) => sh(folder.trim().replace(/^~\/?/, "") || ".");

/**
 * Runs a script that prints sections, each started by a line "@@@ <name>", and returns them by name
 * (print a newline after file contents: a marker must start its own line).
 * Lets one round trip to the computer collect everything a check needs. With `folder`, the script
 * runs there, and a folder that doesn't exist comes back as a "missing" section (it isn't created).
 */
export async function sections(agentId: string, script: string, folder?: string): Promise<Record<string, string>> {
  const prefix = folder ? `cd ${folderArg(folder)} 2>/dev/null || { echo "@@@ missing"; exit 0; }\n` : "";
  const result = await exec(agentId, prefix + script, { timeoutMs: 120_000 });
  const found: Record<string, string> = {};
  let name: string | null = null;
  let lines: string[] = [];
  for (const line of result.stdout.split("\n")) {
    const header = /^@@@ (\S+)$/.exec(line);
    if (header) {
      if (name) found[name] = lines.join("\n");
      name = header[1];
      lines = [];
    } else if (name) {
      lines.push(line);
    }
  }
  if (name) found[name] = lines.join("\n");
  return found;
}

/** The commit HEAD points at, and where the branch left `baseRef` (the merge-base), in a repo folder. */
export async function repoState(agentId: string, cwd: string, baseRef: string): Promise<{ headSha: string | null; baseSha: string }> {
  if (!/^[\w./@^~{}+-]+$/.test(baseRef) || baseRef.startsWith("-")) throw new HttpError(400, `“${baseRef}” isn't a branch, tag or commit name.`);
  const found = await sections(
    agentId,
    `git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "@@@ not-git"; exit 0; }
echo "@@@ head"; git rev-parse HEAD 2>/dev/null
echo "@@@ base"; git merge-base HEAD ${sh(baseRef)} 2>/dev/null || git rev-parse --verify --quiet ${sh(`${baseRef}^{commit}`)}`,
    cwd,
  ).catch((err: unknown) => {
    throw new HttpError(400, `Couldn't reach the agent's computer: ${err instanceof Error ? err.message : String(err)}`);
  });
  if ("missing" in found) throw new HttpError(400, `There's no ${cwd} folder on the agent's computer.`);
  if (!("head" in found)) throw new HttpError(400, `${cwd} isn't a git repository on the agent's computer.`);
  const baseSha = found.base?.trim().split("\n")[0] ?? "";
  if (!baseSha) throw new HttpError(400, `Couldn't find “${baseRef}” in ${cwd}. Use a branch, tag or commit that exists there.`);
  return { headSha: found.head.trim() || null, baseSha };
}
