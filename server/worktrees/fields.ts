import { HttpError } from "../agent/orchestrator.ts";

/**
 * A project's worktree settings as the user gives them (module 09): the setup command every new task
 * worktree runs, and a folder project's files copied into each one. Checked here when they're saved
 * (PATCH /api/projects/:id); setup.ts uses them.
 */

const MAX_COMMAND = 500;
const MAX_FILES = 20;
const MAX_PATH = 200;

/** null = detect it from the lockfile, "" = run nothing, else the command (one line). */
export function cleanSetupCommand(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new HttpError(400, "The setup command must be text.");
  const command = value.trim();
  if (/[\r\n]/.test(command)) throw new HttpError(400, "Keep the setup command on one line (join steps with &&).");
  if (/[\x00-\x08\x0b-\x1f\x7f]/.test(command)) throw new HttpError(400, "The setup command has characters TOT can't run.");
  if (command.length > MAX_COMMAND) throw new HttpError(400, `Keep the setup command under ${MAX_COMMAND} characters.`);
  return command;
}

/** ".env", "config/master.key": paths inside the project's folder. Absolute paths, "~" and ".." are refused. */
export function cleanCopyFiles(value: unknown): string[] {
  if (!Array.isArray(value)) throw new HttpError(400, "List the files to copy.");
  const files: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") throw new HttpError(400, "List the files to copy as paths.");
    const text = item.trim();
    if (!text) continue;
    if (text.length > MAX_PATH || /[\x00-\x1f\x7f]/.test(text)) throw new HttpError(400, `"${text.slice(0, 40)}" isn't a path TOT can copy.`);
    if (text.startsWith("/") || text.startsWith("~")) {
      throw new HttpError(400, `"${text}" isn't inside the project's folder: use a path relative to it, like .env.`);
    }
    const parts = text.split("/");
    if (parts.includes("..")) throw new HttpError(400, `"${text}" leaves the project's folder: paths with ".." can't be copied.`);
    const path = parts.filter((part) => part && part !== ".").join("/");
    if (!path) continue;
    const top = path.split("/")[0]!;
    if (top === ".git" || top === ".tot-worktrees") throw new HttpError(400, `"${path}" is kept by git or TOT itself, so it can't be copied.`);
    if (!files.includes(path)) files.push(path);
  }
  if (files.length > MAX_FILES) throw new HttpError(400, `Copy at most ${MAX_FILES} files.`);
  return files;
}
