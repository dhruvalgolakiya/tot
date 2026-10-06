import { createHash } from "node:crypto";

/**
 * A wiki page as a file (roadmap module 11, lane B): markdown with front matter, in a brain's knowledge repo. The
 * front matter holds what places the page (`id`, `title`, `summary`, `parent`, `pinned`, `position`, `repo`); the
 * rest of the file is the page. Lines a person added to the front matter by hand are kept when TOT rewrites it.
 *
 *     ---
 *     id: 3f2a9c1b-…
 *     title: Run, test & deploy
 *     summary: "Commands for every stage: setup, tests, deploys"
 *     parent: 9d0e…
 *     position: 3
 *     ---
 *
 *     Run one test with `npx vitest run path/to/file.test.ts`.
 *
 * Where files go: the Overview is `pages/overview.md`, other pages `pages/<slug>.md`, and the docs of a project repo
 * (the page with `repo: <name>` and its subtree) `repos/<name>/`, the head page being its `README.md`.
 */

export const PAGES_DIR = "pages";
export const REPOS_DIR = "repos";
export const OVERVIEW_PATH = `${PAGES_DIR}/overview.md`;
export const REPO_HEAD_FILE = "README.md";

export interface PageFields {
  id: string;
  title: string;
  summary: string;
  parentId: string | null;
  pinned: boolean;
  position: number;
  repo: string | null;
  content: string;
}

/** A page file read back: what it says, and the front matter lines TOT doesn't know (kept as they are). */
export interface ParsedPage extends Partial<Omit<PageFields, "content">> {
  content: string;
  extra: string[];
  /** The file had front matter at all. */
  framed: boolean;
}

/** A YAML scalar: plain when that's unambiguous, else double-quoted (JSON's escaping is valid YAML). */
function scalar(value: string): string {
  const plain =
    /^[\p{L}\p{N}(][^\n]*$/u.test(value) &&
    !/[:#]\s|\s#|[:\s]$|^\s|["'`{}[\]|>&*!%@,]/.test(value) &&
    !/^(true|false|yes|no|on|off|null|~|[-+]?[\d.]+(e[-+]?\d+)?)$/i.test(value);
  return plain ? value : JSON.stringify(value);
}

function unscalar(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"')) {
    try {
      return String(JSON.parse(value));
    } catch {
      return value.replace(/^"|"$/g, "");
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) return value.slice(1, -1).replace(/''/g, "'");
  return value === "~" || value === "null" ? "" : value;
}

const KNOWN = new Set(["id", "title", "summary", "parent", "pinned", "position", "repo"]);

/** The file for a page. `extra`: front matter lines from the file as it was, kept. */
export function renderPage(page: PageFields, extra: string[] = []): string {
  const lines = [
    "---",
    `id: ${page.id}`,
    `title: ${scalar(page.title)}`,
    `summary: ${page.summary ? scalar(page.summary) : '""'}`,
    ...(page.parentId ? [`parent: ${page.parentId}`] : []),
    ...(page.pinned ? ["pinned: true"] : []),
    `position: ${Number.isFinite(page.position) ? page.position : 0}`,
    ...(page.repo ? [`repo: ${scalar(page.repo)}`] : []),
    ...extra,
    "---",
  ];
  return page.content ? `${lines.join("\n")}\n\n${page.content}\n` : `${lines.join("\n")}\n`;
}

/** Reads a page file. Tolerant: no front matter, or some fields missing, is fine (the caller fills them in). */
export function parsePage(text: string): ParsedPage {
  const source = text.replace(/\r\n?/g, "\n").replace(/^﻿/, "");
  const lines = source.split("\n");
  if (lines[0]?.trim() !== "---") return { content: source.trim(), extra: [], framed: false };
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end < 0) return { content: source.trim(), extra: [], framed: false };
  const page: ParsedPage = { content: lines.slice(end + 1).join("\n").trim(), extra: [], framed: true };
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z_][\w-]*):(?:\s(.*)|)$/.exec(line);
    const key = match?.[1]?.toLowerCase();
    if (!match || !key || !KNOWN.has(key)) {
      if (line.trim()) page.extra.push(line);
      continue;
    }
    const value = unscalar(match[2] ?? "");
    if (key === "id") page.id = value;
    else if (key === "title") page.title = value;
    else if (key === "summary") page.summary = value;
    else if (key === "parent") page.parentId = value || null;
    else if (key === "pinned") page.pinned = /^(true|yes|on|1)$/i.test(value);
    else if (key === "position") page.position = Number.isFinite(Number(value)) && value !== "" ? Number(value) : undefined;
    else if (key === "repo") page.repo = value || null;
  }
  return page;
}

/** Whether a front matter id can be a page id (TOT's are UUIDs; anything plain and short is accepted). */
export const isPageId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][\w-]{0,79}$/.test(value);

/** An id for a page file that has none of its own (made by hand): stable for its brain and path. */
export const derivedPageId = (brainId: string, path: string) => `p${createHash("sha1").update(`${brainId}\n${path}`).digest("hex").slice(0, 15)}`;

/** "Run, test & deploy" → "run-test-deploy"; "Ärzte" → "arzte". ASCII only, so file names read the same everywhere. */
export function slugify(title: string, fallback = "page"): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug || fallback;
}

/** A repo's name as a folder under repos/. */
export const repoFolder = (name: string) => slugify(name, "repo");

/** The folder a path is in ("pages", "repos/web"). */
export const folderOf = (path: string) => path.split("/").slice(0, -1).join("/");

/** A page file TOT reads: markdown under pages/ or repos/<name>/. */
export const isPagePath = (path: string) => /\.md$/i.test(path) && (path.startsWith(`${PAGES_DIR}/`) || path.startsWith(`${REPOS_DIR}/`));

/** "Run, test & deploy" from "pages/run-test-deploy.md", for a file without a title of its own. */
export function titleFromPath(path: string): string {
  const name = path.split("/").at(-1)!.replace(/\.md$/i, "");
  const base = (name === "README" ? path.split("/").at(-2) : name)?.replace(/[-_]+/g, " ").trim() ?? "Page";
  return base ? `${base.charAt(0).toUpperCase()}${base.slice(1)}` : "Page";
}
