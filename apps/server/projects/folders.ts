import { execFile } from "node:child_process";
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import type { RecentFolder } from "@tot/shared/types";
import type { FolderGrant } from "../computer/types.ts";
import { DATA_DIR } from "../config.ts";

/**
 * Folders on this Mac that agents may work in (module 06): which ones can be shared, the check a
 * grant gets again before every sandboxed command, and the picker's recent git folders.
 *
 * A folder is always its real path (symlinks resolved, in the case the disk stores), and it must be
 * inside your home folder but not the home folder itself, its hidden top-level folders (~/.ssh,
 * ~/.config, ~/.tot…), ~/Library, or TOT's own data. Symlinks inside a shared folder that lead
 * outside it don't widen anything: the sandbox checks real paths.
 */

/** A folder that can't be shared with agents; the message says why, in words for the user. */
export class FolderRefused extends Error {}

/** Folders the picker looks in, one level deep. */
const RECENT_ROOTS = ["code", "projects", "playground", "dev", "src", "Documents/GitHub"];
const MAX_RECENT = 12;
/** What a task's branch and worktree folder may be called: TOT names them (tot/<slug>-<hex>). */
const BRANCH = /^tot\/[A-Za-z0-9._-]+$/;
const WORKTREE_NAME = /^[A-Za-z0-9._-]+$/;

const realHome = () => realpathSync.native(homedir());

const within = (path: string, parent: string) => path.startsWith(`${parent}/`);

function realOrNull(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

/** Why this real path can't be shared, or null when it can. */
function refusal(real: string, home: string): string | null {
  const rel = relative(home, real);
  if (!rel) return "Pick a folder inside your home folder, not the home folder itself.";
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return "Pick a folder inside your home folder.";
  const top = rel.split(sep)[0]!;
  if (top.startsWith(".")) return "Hidden folders at the top of your home folder (like ~/.ssh or ~/.config) can't be shared.";
  if (top.toLowerCase() === "library") return "~/Library can't be shared: it holds your apps' private data.";
  const data = realOrNull(DATA_DIR);
  if (data && (real === data || within(real, data) || within(data, real))) return "That folder holds TOT's own data, so it can't be shared.";
  return null;
}

/** "~/code/web" → "/Users/me/code/web": the real path of a folder agents may be given, or FolderRefused. */
export function resolveFolder(input: string): string {
  const text = input.trim();
  if (!text) throw new FolderRefused("Pick a folder.");
  if (/[\x00-\x1f\x7f]/.test(text)) throw new FolderRefused("That folder's path has characters TOT can't use.");
  if (text.split("/").includes("..")) throw new FolderRefused("Use the folder's own path, without “..”.");
  const home = realHome();
  const expanded = text === "~" ? home : text.startsWith("~/") ? join(home, text.slice(2)) : text;
  if (!isAbsolute(expanded)) throw new FolderRefused("Use the folder's full path, like ~/code/web.");
  const real = realOrNull(expanded);
  if (!real || !statSync(real).isDirectory()) throw new FolderRefused(`There's no folder at ${text}.`);
  const problem = refusal(real, home);
  if (problem) throw new FolderRefused(problem);
  return real;
}

/**
 * Whether tasks can make branches in the folder: "repo" when it has its own .git folder; "linked"
 * when .git is a file (a worktree or submodule of a repo elsewhere, which the grant doesn't cover).
 */
export function gitState(folder: string): "repo" | "linked" | "none" {
  try {
    const git = lstatSync(join(folder, ".git"));
    return git.isDirectory() ? "repo" : git.isFile() ? "linked" : "none";
  } catch {
    return "none";
  }
}

/**
 * A grant checked again right before a sandboxed command uses it: its folder (and the project's other
 * folders it may read, module 11) must still resolve to itself and pass every rule, and a task's branch
 * and worktree must be names TOT made.
 */
export function verifyGrant(grant: FolderGrant): FolderGrant {
  for (const folder of [grant.folder, ...(grant.reads ?? [])]) {
    if (resolveFolder(folder) !== folder) throw new FolderRefused(`The project's folder ${tildePath(folder)} has moved or changed. Add it again.`);
  }
  const real = grant.folder;
  if (grant.task) {
    const { branch, worktree } = grant.task;
    if (!BRANCH.test(branch) || branch.includes("..") || !WORKTREE_NAME.test(worktree) || worktree.startsWith(".")) {
      throw new FolderRefused(`A task can't use the branch "${branch}" in ${tildePath(real)}.`);
    }
    if (gitState(real) !== "repo") throw new FolderRefused(`${tildePath(real)} isn't a git repo, so tasks can't start in it.`);
  }
  return grant;
}

/** Shortens a path below the home folder to ~/…, for prompts and labels. */
export function tildePath(path: string): string {
  for (const home of new Set([homedir(), realOrNull(homedir()) ?? homedir()])) {
    if (path === home) return "~";
    if (within(path, home)) return `~${path.slice(home.length)}`;
  }
  return path;
}

/** Git repos in the usual code folders, one level deep, most recently used first: for the folder picker. */
export function recentGitFolders(): RecentFolder[] {
  const home = realHome();
  const found = new Map<string, number>();
  for (const root of RECENT_ROOTS) {
    const dir = join(home, root);
    if (!existsSync(dir)) continue;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      try {
        const real = resolveFolder(join(dir, name));
        if (gitState(real) !== "repo") continue;
        // Git touches .git itself on every commit, checkout and status: a good sign of recent use.
        const used = statSync(join(real, ".git")).mtimeMs;
        found.set(real, Math.max(found.get(real) ?? 0, used));
      } catch {
        // not a folder, or one that can't be shared
      }
    }
  }
  return [...found]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_RECENT)
    .map(([path]) => ({ path, label: tildePath(path) }));
}

/**
 * macOS's folder picker, shown on this Mac (a browser tab here; the Mac app uses its own sheet): the folder chosen,
 * or null when the user cancels. One at a time. The caller checks that the request comes from this Mac.
 */
let picking = false;
export function pickFolderOnThisMac(): Promise<string | null> {
  if (process.platform !== "darwin") return Promise.reject(new Error("The folder picker is only on a Mac."));
  if (picking) return Promise.reject(new Error("A folder picker is open already."));
  picking = true;
  // `activate` brings osascript's own dialog to the front (no permission needed: it's the current app).
  const script = ['activate', 'set chosen to choose folder with prompt "Choose a folder for TOT" default location (path to home folder)', "POSIX path of chosen"];
  return new Promise<string | null>((resolve, reject) => {
    execFile("/usr/bin/osascript", script.flatMap((line) => ["-e", line]), { timeout: 10 * 60_000 }, (error, stdout, stderr) => {
      picking = false;
      if (!error) return resolve(stdout.trim().replace(/(.)\/$/, "$1") || null);
      // Cancel is error -128.
      if (/-128/.test(String(stderr)) || /-128/.test(error.message)) return resolve(null);
      reject(new Error(`The folder picker didn't open: ${String(stderr).trim() || error.message}`));
    });
  });
}
