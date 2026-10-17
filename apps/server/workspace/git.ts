import { randomBytes } from "node:crypto";
import { HttpError } from "../agent/orchestrator.ts";
import { quote } from "../computer/github-login.ts";
import { computerManager } from "../computer/manager.ts";
import { folderGit, gitWords } from "../landing/git.ts";
import { scrub } from "../trust/shell.ts";
import type { ChatSpace } from "./root.ts";

/**
 * Git in a chat's folder, where the chat's own commands would run it. A worktree or a clone is the agent's to
 * change, config and hooks included, so git runs there on the chat's computer, under its sandbox and folder
 * grant: whatever the agent wrote into it runs no further than the agent itself could. Only the user's own main
 * checkout of a folder project (whose config and hooks agents can't touch) has git run by TOT, as landing does.
 */

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

const TIMEOUT_MS = 60_000;
/** No pager, no colors, paths as they are (not quoted), and no file-system monitor (a program git would start). */
const SAFE = ["-c", "core.quotePath=false", "-c", "color.ui=false", "-c", "core.pager=cat", "-c", "core.fsmonitor=false"];

/** Several git commands in the folder, in one trip to the computer; each one's own result. */
export async function gitBatch(space: ChatSpace, commands: string[][], { timeoutMs = TIMEOUT_MS } = {}): Promise<GitResult[]> {
  if (space.gitHost === "tot") return Promise.all(commands.map((args) => folderGit(space.root, [...SAFE, ...args], { timeoutMs })));
  if (!space.workDir) throw new HttpError(409, "This chat's folder can't be used by its computer right now.");
  const mark = `@@tot-${randomBytes(6).toString("hex")}`;
  // Each command's output, then a line with its exit code, its error output, and an end line.
  const script = commands
    .map((args, i) => {
      const err = `"$TMPDIR/${mark}.${i}"`;
      return `git ${[...SAFE, ...args].map(quote).join(" ")} 2>${err}; printf '\\n${mark} %s\\n' "$?"; cat ${err}; rm -f ${err}; printf '\\n${mark}.\\n'`;
    })
    .join("\n");
  const active = await computerManager.ensure(space.chat.agentId);
  const result = await active.backend.exec(active.externalId, `export GIT_TERMINAL_PROMPT=0 GIT_MERGE_AUTOEDIT=no\n${script}`, {
    cwd: space.workDir,
    timeoutMs,
    grant: space.grant,
  });
  computerManager.touch(space.chat.agentId);
  if (result.timedOut) throw new HttpError(409, "Git took too long in this chat's folder.");
  const parts = result.stdout.split(new RegExp(`\\n${mark} (\\d+)\\n([\\s\\S]*?)\\n${mark}\\.\\n`));
  return commands.map((_, i) => {
    const code = parts[i * 3 + 1];
    if (code === undefined) return { code: 1, stdout: "", stderr: scrub(result.stderr) || "git didn't run" };
    return { code: Number(code), stdout: parts[i * 3]!, stderr: scrub(parts[i * 3 + 2]!) };
  });
}

export async function gitRun(space: ChatSpace, args: string[], options?: { timeoutMs?: number }): Promise<GitResult> {
  return (await gitBatch(space, [args], options))[0]!;
}

/** The same, throwing git's own words when it fails. */
export async function gitOrThrow(space: ChatSpace, args: string[], options?: { timeoutMs?: number }): Promise<string> {
  const result = await gitRun(space, args, options);
  if (result.code !== 0) throw new HttpError(409, gitWords(result.stderr || result.stdout) || `git ${args[0]} failed (exit code ${result.code}).`);
  return result.stdout;
}
