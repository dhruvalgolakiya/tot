import { statSync } from "node:fs";
import { join } from "node:path";
import { memories, type IndexRow } from "../data/memories.ts";
import { projects } from "../projects/projects.ts";
import { listFiles, parseEntries, projectRepoId, readFile, repoDir, repoExists, YOU, type Entry } from "./repo.ts";

/**
 * The memory index (roadmap module 10): the `memories` table rebuilt from a repo's markdown files, after every
 * commit, merge and undo, and for every repo at startup. The files are the truth; the index is for lookups and
 * full-text search. The same id twice in a repo (two devices edited one line): the index keeps the last one,
 * and Dreaming settles it.
 */

/** "tot://c/<chat>" names the chat or task an agent saved it from. */
const CHAT_SOURCE = /^tot:\/\/c\/([\w-]+)$/;

/** Every entry in the repo's markdown files, in file order. */
export function repoEntries(repo: string): Entry[] {
  if (!repoExists(repo)) return [];
  const entries: Entry[] = [];
  for (const path of listFiles(repo)) {
    if (!/\.md$/i.test(path)) continue;
    const content = readFile(repo, path);
    if (content !== null) entries.push(...parseEntries(path, content));
  }
  return entries;
}

function toRow(entry: Entry, fileTime: number): IndexRow {
  const chat = entry.source ? CHAT_SOURCE.exec(entry.source)?.[1] ?? null : null;
  const agent = Boolean(chat) || entry.source === "dreaming" || entry.source === "tot";
  // A date alone: noon local time, so it reads as that day everywhere.
  const createdAt = entry.added ? new Date(`${entry.added}T12:00:00`).getTime() : fileTime;
  return {
    id: entry.id,
    repo: "",
    path: entry.path,
    line: entry.line,
    content: entry.text,
    source: agent ? "agent" : "user",
    sourceRef: entry.source,
    conversationId: chat,
    derived: entry.derived,
    createdAt: Number.isFinite(createdAt) ? createdAt : fileTime,
  };
}

export function reindex(repo: string): number {
  const rows = new Map<string, IndexRow>();
  const times = new Map<string, number>();
  for (const entry of repoEntries(repo)) {
    if (!times.has(entry.path)) {
      let time = Date.now();
      try {
        time = statSync(join(repoDir(repo), ...entry.path.split("/"))).mtimeMs;
      } catch {
        // gone meanwhile
      }
      times.set(entry.path, time);
    }
    // Keep the last line with an id, at its own place.
    rows.delete(entry.id);
    rows.set(entry.id, toRow(entry, times.get(entry.path)!));
  }
  memories.replaceRepo(repo, [...rows.values()].map((row) => ({ ...row, repo })));
  return rows.size;
}

/** Every repo on this device: "you", then each project's that exists. */
export function knownRepos(): string[] {
  const all = [...projects.list(), ...projects.list({ archived: true })];
  return [YOU, ...all.map((project) => projectRepoId(project.slug)).filter((repo) => repoExists(repo))];
}

export function reindexAll(): void {
  const repos = knownRepos();
  memories.pruneRepos(repos);
  for (const repo of repos) reindex(repo);
}
