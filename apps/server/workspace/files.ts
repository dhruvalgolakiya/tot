import { spawn } from "node:child_process";
import { closeSync, constants, existsSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readSync, statSync, writeSync } from "node:fs";
import { delimiter, dirname, extname, join } from "node:path";
import { createInterface } from "node:readline";
import type { WorkspaceFile, WorkspaceFiles, WorkspaceSave, WorkspaceSaved, WorkspaceSearch, WorkspaceSearchHit } from "@tot/shared/workspace";
import { HttpError } from "../agent/orchestrator.ts";
import { gitBatch } from "./git.ts";
import { inside, isLink, type ChatSpace } from "./root.ts";

/**
 * The Files tab: a chat folder's files (what git doesn't ignore), one file read or saved, its images, and a
 * search through it all. TOT reads and writes them itself, always through `inside`, and never through a link:
 * a file is opened without following a symlink in its last step, so a link put there meanwhile isn't followed.
 */

const MAX_FILES = 50_000;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_SAVE_BYTES = 5 * 1024 * 1024;
const MAX_HITS = 500;
const MAX_HIT_CHARS = 300;
const SEARCH_TIMEOUT_MS = 10_000;
/** Folders a walk of a folder without git skips. */
const SKIPPED = new Set([".git", "node_modules", ".tot-worktrees", ".next", ".turbo", ".cache"]);

export const IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
};

const imageType = (path: string) => IMAGE_TYPES[extname(path).toLowerCase()] ?? null;

/** Every file in a folder without git, links not followed, up to MAX_FILES. */
function walk(root: string): { files: string[]; truncated: boolean } {
  const files: string[] = [];
  const pending: string[] = [""];
  while (pending.length) {
    const dir = pending.pop()!;
    let entries;
    try {
      entries = readdirSync(dir ? join(root, dir) : root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!SKIPPED.has(entry.name)) pending.push(rel);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        if (files.length >= MAX_FILES) return { files, truncated: true };
        files.push(rel);
      }
    }
  }
  return { files, truncated: false };
}

/** Reads up to `limit` bytes of a file, never through a symlink in its last step. */
function readCapped(path: string, limit: number): { buffer: Buffer; size: number; mtime: number } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new HttpError(400, "That isn't a file.");
    const buffer = Buffer.alloc(Math.min(stat.size, limit));
    let read = 0;
    while (read < buffer.length) {
      const got = readSync(fd, buffer, read, buffer.length - read, read);
      if (!got) break;
      read += got;
    }
    return { buffer: buffer.subarray(0, read), size: stat.size, mtime: stat.mtimeMs };
  } finally {
    closeSync(fd);
  }
}

/** A ripgrep binary on this Mac, if there's one. */
function ripgrep(): string | null {
  const dirs = [...(process.env.PATH ?? "").split(delimiter), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];
  for (const dir of dirs) {
    const file = dir && join(dir, "rg");
    if (file && existsSync(file)) return file;
  }
  return null;
}

interface SearchOptions {
  query: string;
  regex: boolean;
  caseSensitive: boolean;
}

function searchWithRipgrep(binary: string, root: string, { query, regex, caseSensitive }: SearchOptions): Promise<WorkspaceSearch> {
  const args = ["--json", "--hidden", "--max-filesize", "2M", "--max-columns", "1000", "-g", "!.git", "-g", "!.tot-worktrees", caseSensitive ? "-s" : "-i"];
  if (!regex) args.push("-F");
  args.push("-e", query, "--", ".");
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "" } });
    const hits: WorkspaceSearchHit[] = [];
    let truncated = false;
    let stderr = "";
    const timer = setTimeout(() => {
      truncated = true;
      child.kill("SIGKILL");
    }, SEARCH_TIMEOUT_MS);
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (truncated) return;
      let event: { type?: string; data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number; submatches?: { start: number }[] } };
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type !== "match" || !event.data?.path?.text) return;
      const text = (event.data.lines?.text ?? "").replace(/\r?\n$/, "");
      // ripgrep counts columns in bytes; the panel wants characters.
      const byte = event.data.submatches?.[0]?.start ?? 0;
      const column = Buffer.from(text).subarray(0, byte).toString().length + 1;
      hits.push({ path: event.data.path.text.replace(/^\.\//, ""), line: event.data.line_number ?? 1, column, text: text.slice(0, MAX_HIT_CHARS) });
      if (hits.length >= MAX_HITS) {
        truncated = true;
        child.kill("SIGKILL");
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      // 1: no matches. 2 with nothing found: a bad pattern (or every file unreadable).
      if (code === 2 && !hits.length && !truncated) reject(new HttpError(400, stderr.trim().split("\n").pop() || "That search couldn't run."));
      else resolve({ hits, truncated });
    });
  });
}

function searchInNode(root: string, files: string[], { query, regex, caseSensitive }: SearchOptions): WorkspaceSearch {
  let pattern: RegExp;
  try {
    pattern = new RegExp(regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), caseSensitive ? "" : "i");
  } catch (err) {
    throw new HttpError(400, `That isn't a regular expression: ${err instanceof Error ? err.message : String(err)}`);
  }
  const hits: WorkspaceSearchHit[] = [];
  const deadline = Date.now() + SEARCH_TIMEOUT_MS;
  for (const file of files) {
    if (Date.now() > deadline) return { hits, truncated: true };
    let text: string;
    try {
      const path = inside(root, file).path;
      if (isLink(path) || statSync(path).size > MAX_TEXT_BYTES) continue;
      const buffer = readFileSync(path);
      if (buffer.subarray(0, 8000).includes(0)) continue;
      text = buffer.toString("utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const match = pattern.exec(lines[i]!);
      if (!match) continue;
      hits.push({ path: file, line: i + 1, column: match.index + 1, text: lines[i]!.replace(/\r$/, "").slice(0, MAX_HIT_CHARS) });
      if (hits.length >= MAX_HITS) return { hits, truncated: true };
    }
  }
  return { hits, truncated: false };
}

export const workspaceFiles = {
  async list(space: ChatSpace): Promise<WorkspaceFiles> {
    if (!space.git) return walk(space.root);
    const [listed, deleted] = await gitBatch(space, [
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      ["ls-files", "-z", "--deleted"],
    ]);
    if (listed!.code !== 0) return walk(space.root);
    const gone = new Set(deleted!.stdout.split("\0"));
    const files = [...new Set(listed!.stdout.split("\0"))].filter((path) => path && !gone.has(path) && !path.startsWith(".tot-worktrees/")).sort();
    return files.length > MAX_FILES ? { files: files.slice(0, MAX_FILES), truncated: true } : { files, truncated: false };
  },

  read(space: ChatSpace, input: unknown): WorkspaceFile {
    const { path, rel } = inside(space.root, input);
    if (!rel) throw new HttpError(400, "Name a file.");
    if (statSync(path).isDirectory()) throw new HttpError(400, `${rel} is a folder.`);
    const stat = statSync(path);
    if (imageType(rel)) return { path: rel, kind: stat.size > MAX_IMAGE_BYTES ? "too-large" : "image", size: stat.size, mtime: stat.mtimeMs };
    if (stat.size > MAX_TEXT_BYTES) return { path: rel, kind: "too-large", size: stat.size, mtime: stat.mtimeMs };
    const { buffer, size, mtime } = readCapped(path, MAX_TEXT_BYTES);
    if (buffer.subarray(0, 8000).includes(0)) return { path: rel, kind: "binary", size, mtime };
    return { path: rel, kind: "text", content: buffer.toString("utf8"), size, mtime };
  },

  /** An image's bytes and type, for the preview (nothing else is served raw). */
  raw(space: ChatSpace, input: unknown): { body: Buffer; type: string } {
    const { path, rel } = inside(space.root, input);
    const type = imageType(rel);
    if (!type) throw new HttpError(400, "Only images are shown as they are.");
    const { buffer, size } = readCapped(path, MAX_IMAGE_BYTES);
    if (size > MAX_IMAGE_BYTES) throw new HttpError(400, "That image is too large to show.");
    return { body: buffer, type };
  },

  save(space: ChatSpace, input: WorkspaceSave): WorkspaceSaved {
    if (!input || typeof input.content !== "string") throw new HttpError(400, "Send the file's content.");
    if (Buffer.byteLength(input.content) > MAX_SAVE_BYTES) throw new HttpError(400, "That's too much to save from here.");
    const { path, rel } = inside(space.root, input.path, { exists: false });
    if (!rel) throw new HttpError(400, "Name a file.");
    if (!existsSync(dirname(path)) || !statSync(dirname(path)).isDirectory()) throw new HttpError(400, `There's no folder for ${rel}.`);
    if (existsSync(path)) {
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new HttpError(400, `${rel} isn't a file TOT can save over.`);
      if (typeof input.baseMtime === "number" && Math.abs(stat.mtimeMs - input.baseMtime) > 1) {
        throw new HttpError(409, `${rel} changed since you opened it. Reload it, then make your change again.`);
      }
    }
    // The folder it goes in is checked again right before writing, then the file opened without following a link.
    inside(space.root, dirname(rel) === "." ? "" : dirname(rel));
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o644);
    try {
      writeSync(fd, input.content);
      const stat = fstatSync(fd);
      return { path: rel, size: stat.size, mtime: stat.mtimeMs };
    } finally {
      closeSync(fd);
    }
  },

  async search(space: ChatSpace, query: unknown, { regex = false, caseSensitive = false } = {}): Promise<WorkspaceSearch> {
    if (typeof query !== "string" || !query.trim()) return { hits: [], truncated: false };
    if (query.length > 500) throw new HttpError(400, "That search is too long.");
    const options = { query, regex, caseSensitive };
    const binary = ripgrep();
    if (binary) {
      try {
        return await searchWithRipgrep(binary, space.root, options);
      } catch (err) {
        if (err instanceof HttpError) throw err;
      }
    }
    return searchInNode(space.root, (await workspaceFiles.list(space)).files, options);
  },
};
