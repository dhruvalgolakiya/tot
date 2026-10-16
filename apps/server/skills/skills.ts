import { closeSync, openSync, readdirSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SkillInfo, SkillSource } from "@tot/shared/types";
import { accountDir, accounts, accountsHome } from "../accounts/accounts.ts";
import { claudePlugins } from "../accounts/config.ts";

/**
 * Skills the user can invoke from a message ("/dh-stack fix the cart"), the way Claude Code and Codex do. TOT runs
 * both providers without the user's own config (settingSources: [], Codex skills off), so nothing loads a skill on
 * its own: an invoked skill's SKILL.md is put into that one turn's prompt instead (see `skillBlock`).
 *
 * A skill is a folder with a SKILL.md whose YAML frontmatter has `name` and `description`. The list reads the
 * frontmatter only; the body is read when a turn uses the skill.
 */

export interface SkillRecord extends SkillInfo {
  /** The skill's folder, as found (a symlinked folder keeps its link's path). */
  dir: string;
  file: string;
}

interface Root {
  dir: string;
  source: SkillSource;
  pluginName?: string;
}

const CACHE_TTL_MS = 30_000;
/** A miss re-scans at most this often, so a skill installed a moment ago is found without waiting out the TTL. */
const MISS_RESCAN_MS = 2_000;
/** Frontmatter sits at the top: the list never reads further than this into a file. */
const HEAD_BYTES = 32 * 1024;
const MAX_BODY_BYTES = 256 * 1024;
const DESCRIPTION_CHARS = 200;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Where skills live, first wins a name: the Claude account TOT uses by default, the other Claude accounts, the
 * default Claude, shared (~/.agents) and Codex folders, the Codex accounts, then the Claude accounts' enabled plugins.
 */
function roots(): Root[] {
  const home = accountsHome();
  const enabled = accounts.list().filter((account) => account.enabled);
  const active = accounts.get(accounts.defaultId("claude"));
  const claude = [...(active ? [active] : []), ...enabled.filter((account) => account.driver === "claude" && account.id !== active?.id)];
  const codex = enabled.filter((account) => account.driver === "chatgpt");
  const list: Root[] = [
    ...claude.map((account) => ({ dir: join(accountDir(account), "skills"), source: "claude" as const })),
    { dir: join(home, ".claude", "skills"), source: "claude" },
    { dir: join(home, ".agents", "skills"), source: "agents" },
    { dir: join(home, ".codex", "skills"), source: "codex" },
    ...codex.map((account) => ({ dir: join(accountDir(account), "skills"), source: "codex" as const })),
  ];
  for (const account of claude) {
    for (const plugin of claudePlugins(account)) list.push({ dir: join(plugin.path, "skills"), source: "plugin", pluginName: pluginName(plugin) });
  }
  const seen = new Set<string>();
  return list.filter((root) => {
    const key = `${realOrSelf(root.dir)}\0${root.pluginName ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** A plugin's name as Claude Code shows it before its skills ("voyager:make-image"): its manifest's, else its id's. */
function pluginName(plugin: { name: string; path: string }): string {
  try {
    const manifest = JSON.parse(readFileSync(join(plugin.path, ".claude-plugin", "plugin.json"), "utf8")) as { name?: unknown };
    if (typeof manifest.name === "string" && NAME.test(manifest.name)) return manifest.name;
  } catch {
    // No manifest: the id it was enabled under.
  }
  return plugin.name.split("@")[0]!;
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

// ---------------------------------------------------------------------------
// Frontmatter: the small part of YAML skill files use (plain, quoted and block scalars). Nested values are skipped.
// ---------------------------------------------------------------------------

const KEY_LINE = /^([A-Za-z0-9_-]+):(?:\s+(.*))?$/;

/** The frontmatter block's text and where the body starts, or null when the file has none. */
function splitFrontmatter(text: string): { yaml: string; body: string } | null {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  const end = lines.findIndex((line, i) => i > 0 && /^(---|\.\.\.)\s*$/.test(line));
  if (end === -1) return null;
  return { yaml: lines.slice(1, end).join("\n"), body: lines.slice(end + 1).join("\n") };
}

function unquoteDouble(raw: string): string {
  return raw.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, escape: string) => {
    if (escape.length === 5) return String.fromCharCode(parseInt(escape.slice(1), 16));
    return ({ n: "\n", t: "\t", r: "\r", "0": "\0" } as Record<string, string>)[escape] ?? escape;
  });
}

/** Top-level string values of a YAML block. */
export function parseFrontmatter(yaml: string): Record<string, string> {
  const lines = yaml.split("\n");
  const out: Record<string, string> = {};
  for (let i = 0; i < lines.length; i++) {
    const match = KEY_LINE.exec(lines[i]!);
    if (!match) continue;
    const key = match[1]!;
    const first = (match[2] ?? "").trim();
    // The lines that belong to this key: indented ones (and blank ones between them).
    const rest: string[] = [];
    while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]!) || (!lines[i + 1]!.trim() && i + 2 < lines.length && /^\s/.test(lines[i + 2]!)))) {
      rest.push(lines[++i]!);
    }
    if (/^[|>][+-]?\d*$/.test(first)) {
      const indent = Math.min(...rest.filter((line) => line.trim()).map((line) => /^\s*/.exec(line)![0].length));
      const block = rest.map((line) => line.slice(Number.isFinite(indent) ? indent : 0));
      out[key] = (first.startsWith("|") ? block.join("\n") : block.join("\n").replace(/([^\n])\n(?=[^\n])/g, "$1 ")).trim();
      continue;
    }
    const joined = [first, ...rest.map((line) => line.trim())].join(" ").trim();
    if (joined.startsWith('"')) {
      const closed = /^"((?:[^"\\]|\\.)*)"/.exec(joined);
      if (closed) out[key] = unquoteDouble(closed[1]!);
    } else if (joined.startsWith("'")) {
      const closed = /^'((?:[^']|'')*)'/.exec(joined);
      if (closed) out[key] = closed[1]!.replace(/''/g, "'");
    } else if (first && !first.startsWith("[") && !first.startsWith("{")) {
      out[key] = joined.replace(/\s+#.*$/, "");
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Discovery, cached: a scan stats folders and files, and reads a SKILL.md again only when it changed.
// ---------------------------------------------------------------------------

type FileMeta = { name?: string; description?: string } | null;
const fileCache = new Map<string, { mtimeMs: number; size: number; meta: FileMeta }>();
let cache: { at: number; list: SkillRecord[] } | null = null;

function readHead(file: string): string {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const read = readSync(fd, buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** A SKILL.md's frontmatter (null without one), from the cache while the file is unchanged. */
function metaOf(file: string, mtimeMs: number, size: number): FileMeta {
  const cached = fileCache.get(file);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached.meta;
  let meta: FileMeta = null;
  try {
    const split = splitFrontmatter(readHead(file));
    if (split) {
      const values = parseFrontmatter(split.yaml);
      meta = { name: values.name?.trim(), description: values.description };
    }
  } catch {
    meta = null;
  }
  fileCache.set(file, { mtimeMs, size, meta });
  return meta;
}

function oneLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

function scanRoot(root: Root, into: Map<string, SkillRecord>): void {
  let entries: string[];
  try {
    entries = readdirSync(root.dir);
  } catch {
    return;
  }
  for (const entry of entries.sort()) {
    if (entry.startsWith(".")) continue;
    const dir = join(root.dir, entry);
    const file = join(dir, "SKILL.md");
    let stat;
    try {
      // statSync follows symlinks: a linked skill folder (or SKILL.md) counts like a real one.
      if (!statSync(dir).isDirectory()) continue;
      stat = statSync(file);
      if (!stat.isFile()) continue;
    } catch {
      continue;
    }
    const meta = metaOf(file, stat.mtimeMs, stat.size);
    if (!meta) continue;
    const base = meta.name && NAME.test(meta.name) ? meta.name : NAME.test(entry) ? entry : null;
    if (!base) continue;
    const name = root.pluginName ? `${root.pluginName}:${base}` : base;
    if (into.has(name)) continue;
    into.set(name, {
      name,
      description: oneLine(meta.description ?? "", DESCRIPTION_CHARS),
      source: root.source,
      ...(root.pluginName ? { pluginName: root.pluginName } : {}),
      dir,
      file,
    });
  }
}

function scan(): SkillRecord[] {
  const found = new Map<string, SkillRecord>();
  for (const root of roots()) scanRoot(root, found);
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** "/dh-stack fix the cart" → { name: "dh-stack", rest: "fix the cart" }; null unless the text starts with "/name". */
export function slashSkill(text: string): { name: string; rest: string } | null {
  const match = /^\/([A-Za-z0-9][\w.:-]*)(?:\s+([\s\S]*))?$/.exec(text);
  if (!match) return null;
  return { name: match[1]!, rest: (match[2] ?? "").trim() };
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** What a turn that invoked a skill tells the model before the user's text. */
export function skillBlock(skill: Pick<SkillRecord, "name" | "dir">, body: string): string {
  return [
    `<skill name="${escapeAttr(skill.name)}" path="${escapeAttr(skill.dir)}">`,
    body.trim(),
    "</skill>",
    "The user invoked the skill above for this message. Follow its instructions. Its other files (references, scripts) are in the folder at path; read them with the skill_read tool when the instructions point to them.",
  ].join("\n");
}

export const skills = {
  /** Every skill, sorted by name. */
  list(now = Date.now()): SkillRecord[] {
    if (!cache || now - cache.at >= CACHE_TTL_MS) cache = { at: now, list: scan() };
    return cache.list;
  },

  /** The skill with this name (case-insensitive when no exact match), looking again once when it's missing. */
  find(name: string): SkillRecord | null {
    const pick = (list: SkillRecord[]) => list.find((s) => s.name === name) ?? list.find((s) => s.name.toLowerCase() === name.toLowerCase()) ?? null;
    const hit = pick(skills.list());
    if (hit || (cache && Date.now() - cache.at < MISS_RESCAN_MS)) return hit;
    cache = null;
    return pick(skills.list());
  },

  /** The SKILL.md without its frontmatter, for the turn that invoked it. */
  body(skill: Pick<SkillRecord, "file">): string {
    const fd = openSync(skill.file, "r");
    let text: string;
    try {
      const buffer = Buffer.alloc(MAX_BODY_BYTES);
      const read = readSync(fd, buffer, 0, MAX_BODY_BYTES, 0);
      text = buffer.subarray(0, read).toString("utf8");
    } finally {
      closeSync(fd);
    }
    return splitFrontmatter(text)?.body ?? text;
  },

  /** Drops the cache, so the next list scans again. */
  refresh(): void {
    cache = null;
  },
};

/** The public shape (no paths). */
export function toSkillInfo(skill: SkillRecord): SkillInfo {
  return { name: skill.name, description: skill.description, source: skill.source, ...(skill.pluginName ? { pluginName: skill.pluginName } : {}) };
}
