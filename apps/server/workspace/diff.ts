import type { WorkspaceChange, WorkspaceChangeStatus, WorkspaceDiff, WorkspaceFileDiff } from "@tot/shared/workspace";
import { HttpError } from "../agent/orchestrator.ts";
import { gitBatch, gitRun } from "./git.ts";
import { readInside } from "./files.ts";
import { cleanPath, type ChatSpace } from "./root.ts";

/**
 * A chat folder's changes against its last commit: what's changed in the working tree (staged or not) and the
 * files git doesn't track yet, with +/− line counts; and one file's unified diff at a time. Diffs never go
 * through an external diff tool or a textconv filter, whatever the repo's attributes say.
 */

/** git's empty tree: what a repo without a commit yet is compared with. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MAX_FILES = 2000;
/** An untracked file larger than this is listed without counting its lines. */
const MAX_COUNTED_BYTES = 2 * 1024 * 1024;
const MAX_PATCH_CHARS = 1_500_000;
const DIFF = ["--no-color", "--no-ext-diff", "--no-textconv", "-M"];

/** The first bytes of a file in the folder, and whether it holds a NUL (git's own test for binary). */
function head(root: string, path: string, bytes: number): { buffer: Buffer; size: number; binary: boolean } {
  const { buffer, size } = readInside(root, path, bytes);
  return { buffer, size, binary: buffer.subarray(0, 8000).includes(0) };
}

function lineCount(text: string): number {
  if (!text) return 0;
  const lines = text.split("\n").length;
  return text.endsWith("\n") ? lines - 1 : lines;
}

/** `git status --porcelain=v1 -z`: each path's status, and a rename's old path. */
function parseStatus(out: string): Map<string, { status: WorkspaceChangeStatus; oldPath?: string }> {
  const found = new Map<string, { status: WorkspaceChangeStatus; oldPath?: string }>();
  const fields = out.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]!;
    if (entry.length < 4) continue;
    const [x, y, path] = [entry[0]!, entry[1]!, entry.slice(3)];
    if (x === "!") continue;
    if (x === "R" || x === "C") {
      found.set(path, { status: "renamed", oldPath: fields[++i] });
    } else if (x === "?") {
      found.set(path, { status: "untracked" });
    } else if (x === "A" || (x === " " && y === "A")) {
      found.set(path, { status: "added" });
    } else if (x === "D" || y === "D") {
      found.set(path, { status: "deleted" });
    } else {
      found.set(path, { status: "modified" });
    }
  }
  return found;
}

/** `git diff --numstat -z`: lines added and removed per path ("-" for a binary file). */
function parseNumstat(out: string): Map<string, { added: number; removed: number; binary: boolean }> {
  const found = new Map<string, { added: number; removed: number; binary: boolean }>();
  const fields = out.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(fields[i]!);
    if (!match) continue;
    let path = match[3]!;
    // A rename's paths follow as their own fields: old, then new.
    if (!path) {
      i += 2;
      path = fields[i] ?? "";
    }
    const binary = match[1] === "-";
    found.set(path, { added: binary ? 0 : Number(match[1]), removed: binary ? 0 : Number(match[2]), binary });
  }
  return found;
}

async function base(space: ChatSpace): Promise<string> {
  const head = await gitRun(space, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  return head.code === 0 && head.stdout.trim() ? "HEAD" : EMPTY_TREE;
}

export const workspaceDiff = {
  async list(space: ChatSpace): Promise<WorkspaceDiff> {
    if (!space.git) return { branch: null, files: [], truncated: false };
    const against = await base(space);
    const [branch, status, numstat] = await gitBatch(space, [
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"],
      ["diff", against, "--numstat", "-z", ...DIFF],
    ]);
    if (status!.code !== 0) throw new HttpError(409, `Git couldn't read this folder: ${status!.stderr.trim().split("\n").pop() ?? ""}`);
    const statuses = parseStatus(status!.stdout);
    const counts = parseNumstat(numstat!.stdout);
    const files: WorkspaceChange[] = [];
    // Renames as git's diff found them (status runs without rename detection, so its old path shows as deleted).
    const renamedFrom = new Set<string>();
    for (const line of numstat!.stdout.matchAll(/(?:^|\0)(?:-|\d+)\t(?:-|\d+)\t\0([^\0]*)\0([^\0]*)/g)) {
      renamedFrom.add(line[1]!);
      statuses.set(line[2]!, { status: "renamed", oldPath: line[1] });
    }
    for (const [path, { status: kind, oldPath }] of statuses) {
      if (renamedFrom.has(path)) continue;
      if (files.length >= MAX_FILES) return { branch: branch!.stdout.trim() || null, files, truncated: true };
      const count = counts.get(path);
      const change: WorkspaceChange = { path, status: kind, added: count?.added ?? 0, removed: count?.removed ?? 0, binary: count?.binary ?? false };
      if (oldPath) change.oldPath = oldPath;
      if (kind === "untracked") {
        try {
          const file = head(space.root, path, MAX_COUNTED_BYTES);
          change.binary = file.binary;
          if (!file.binary && file.size <= MAX_COUNTED_BYTES) change.added = lineCount(file.buffer.toString("utf8"));
        } catch {
          // A link out of the folder, or gone since: listed, not read.
        }
      }
      files.push(change);
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    return { branch: branch!.stdout.trim() || null, files, truncated: false };
  },

  /** One file's diff; `old` is a renamed file's path before, so the diff shows the rename. */
  async file(space: ChatSpace, input: unknown, old?: unknown): Promise<WorkspaceFileDiff> {
    const path = cleanPath(input);
    const oldPath = old ? cleanPath(old) : "";
    if (!path) throw new HttpError(400, "Name a file.");
    if (!space.git) throw new HttpError(409, "This folder isn't a git repo.");
    const tracked = await gitRun(space, ["--literal-pathspecs", "ls-files", "--error-unmatch", "--", path]);
    const deleted = tracked.code === 0 ? null : await gitRun(space, ["cat-file", "-e", `HEAD:${path}`]);
    if (tracked.code !== 0 && deleted?.code !== 0) {
      // Untracked: the whole file is new. Read here, inside the folder, rather than by `git diff --no-index`.
      const file = head(space.root, path, MAX_PATCH_CHARS);
      if (file.binary) return { path, patch: "", binary: true, truncated: false };
      const text = file.buffer.toString("utf8");
      const lines = text.split("\n");
      if (text.endsWith("\n")) lines.pop();
      const patch = [`diff --git a/${path} b/${path}`, "new file", "--- /dev/null", `+++ b/${path}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)].join("\n");
      return { path, patch: `${patch}\n`, binary: false, truncated: file.size > MAX_PATCH_CHARS };
    }
    const result = await gitRun(space, ["--literal-pathspecs", "diff", await base(space), ...DIFF, "--", ...(oldPath && oldPath !== path ? [oldPath] : []), path]);
    if (result.code !== 0) throw new HttpError(409, `Git couldn't diff ${path}.`);
    const binary = /^Binary files .* differ$/m.test(result.stdout);
    const truncated = result.stdout.length > MAX_PATCH_CHARS;
    return { path, patch: truncated ? result.stdout.slice(0, result.stdout.lastIndexOf("\n", MAX_PATCH_CHARS) + 1) : result.stdout, binary, truncated };
  },
};
