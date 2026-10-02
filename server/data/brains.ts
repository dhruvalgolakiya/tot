import { randomUUID } from "node:crypto";
import type { Brain, BrainAccess, BrainInput, BrainKind, BrainPatch } from "../../shared/types.ts";
import { NOTEBOOK_DESCRIPTION, NOTEBOOK_NAME, db, parseJson, type Row } from "../db.ts";

/**
 * Brains: knowledge bases at the app level, each a wiki (see wiki.ts). Every
 * agent owns a private notebook brain; shared brains — a repo, a client, a
 * product — are attached to the agents that need them (read or write), or to
 * every agent. Which brains a request is about is found from plain signals
 * (`brains.match`), not by asking a model.
 */

export class BrainError extends Error {}

/** A brain as one agent sees it. */
export type AgentBrain = Brain & { access: BrainAccess };

const MAX_NAME = 80;
const MAX_DESCRIPTION = 300;
const MAX_KEYWORDS = 20;

function toBrain(row: Row): Brain {
  const id = String(row.id);
  const agentsRows = db.prepare(`SELECT agent_id, access FROM brain_agents WHERE brain_id = ? ORDER BY rowid`).all(id) as Row[];
  return {
    id,
    name: String(row.name),
    kind: row.kind as BrainKind,
    description: String(row.description),
    source: (row.source as string | null) ?? null,
    keywords: parseJson<string[]>(row.keywords, []),
    ownerAgentId: (row.owner_agent_id as string | null) ?? null,
    allAgents: Boolean(row.all_agents),
    agents: agentsRows.map((r) => ({ agentId: String(r.agent_id), access: r.access as BrainAccess })),
    pageCount: Number(
      (db.prepare(`SELECT COUNT(*) AS n FROM wiki_pages WHERE brain_id = ? AND deleted_at IS NULL`).get(id) as Row).n,
    ),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function cleanName(value: unknown): string {
  const name = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (!name || name.length > MAX_NAME) throw new BrainError(`Brain names need 1–${MAX_NAME} characters.`);
  return name;
}

function cleanDescription(value: unknown): string {
  const text = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  if (text.length > MAX_DESCRIPTION) throw new BrainError(`Keep the description under ${MAX_DESCRIPTION} characters (it's one line).`);
  return text;
}

function cleanKeywords(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new BrainError("Keywords must be a list of words.");
  const words = value
    .filter((word): word is string => typeof word === "string")
    .map((word) => word.trim())
    .filter((word) => word.length >= 2 && word.length <= 60);
  return [...new Set(words.map((word) => word.toLowerCase()))].slice(0, MAX_KEYWORDS);
}

/** "https://github.com/acme/web.git" → "acme/web"; null for anything that isn't a GitHub repo. */
export function githubFullName(source: string): string | null {
  const match = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(source.trim());
  return match ? `${match[1]}/${match[2]}` : null;
}

/** The folder name a repo is cloned into: ~/repos/<this>. */
export function cloneFolder(source: string): string {
  const last = source.replace(/[/\\]+$/, "").split(/[/:\\]/).pop() ?? "";
  return last.replace(/\.git$/i, "").replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[.-]+/, "") || "repo";
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Phrases that, found in a request or a command, mean it's about this brain. */
export function brainSignals(brain: Pick<Brain, "name" | "kind" | "source" | "keywords">): RegExp[] {
  const patterns: RegExp[] = [new RegExp(`(?:^|[\\s(\`"'])@${escape(brain.name)}\\b`, "i")];
  if (brain.kind === "repo" && brain.source) {
    const fullName = githubFullName(brain.source);
    if (fullName) patterns.push(new RegExp(`(?:^|[^\\w.-])${escape(fullName)}(?![\\w-])`, "i"));
    else patterns.push(new RegExp(escape(brain.source.replace(/[/\\]+$/, "")), "i"));
    patterns.push(new RegExp(`repos/${escape(cloneFolder(brain.source))}(?![\\w.-])`, "i"));
  }
  for (const keyword of brain.keywords) patterns.push(new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escape(keyword)}(?![\\p{L}\\p{N}_])`, "iu"));
  return patterns;
}

const ORDER = `ORDER BY (b.owner_agent_id IS NULL), (SELECT created_at FROM agents a WHERE a.id = b.owner_agent_id), b.name COLLATE NOCASE`;

export const brains = {
  list(): Brain[] {
    return (db.prepare(`SELECT * FROM brains b WHERE deleted_at IS NULL ${ORDER}`).all() as Row[]).map(toBrain);
  },

  get(id: string): Brain | null {
    const row = db.prepare(`SELECT * FROM brains WHERE id = ? AND deleted_at IS NULL`).get(id) as Row | undefined;
    return row ? toBrain(row) : null;
  },

  /** The agent's private notebook, created on first use. */
  notebook(agentId: string): Brain {
    const row = db.prepare(`SELECT * FROM brains WHERE owner_agent_id = ?`).get(agentId) as Row | undefined;
    if (row) return toBrain(row);
    const id = randomUUID();
    const now = Date.now();
    db.prepare(
      `INSERT INTO brains (id, name, kind, description, owner_agent_id, created_at, updated_at) VALUES (?, ?, 'notebook', ?, ?, ?, ?)`,
    ).run(id, NOTEBOOK_NAME, NOTEBOOK_DESCRIPTION, agentId, now, now);
    return brains.get(id)!;
  },

  /** Every brain an agent can use — its notebook first — with what it may do there. */
  forAgent(agentId: string): AgentBrain[] {
    brains.notebook(agentId);
    const rows = db
      .prepare(
        `SELECT b.*, CASE WHEN b.owner_agent_id = ? OR b.all_agents = 1 THEN 'write' ELSE ba.access END AS my_access
         FROM brains b LEFT JOIN brain_agents ba ON ba.brain_id = b.id AND ba.agent_id = ?
         WHERE b.deleted_at IS NULL AND (b.owner_agent_id = ? OR b.all_agents = 1 OR ba.agent_id IS NOT NULL)
         ORDER BY (b.owner_agent_id IS NULL), b.name COLLATE NOCASE`,
      )
      .all(agentId, agentId, agentId) as Row[];
    return rows.map((row) => ({ ...toBrain(row), access: row.my_access as BrainAccess }));
  },

  /** What an agent may do in a brain, or null when it can't see it. */
  access(agentId: string, brainId: string): BrainAccess | null {
    return brains.forAgent(agentId).find((brain) => brain.id === brainId)?.access ?? null;
  },

  /** A brain an agent can see, by id or (case-insensitive) name; "notebook" means its own. */
  resolve(agentId: string, ref: string): AgentBrain | null {
    const key = ref.trim().replace(/^@/, "").toLowerCase();
    const mine = brains.forAgent(agentId);
    if (key === "notebook" || key === "my notebook") return mine[0];
    return mine.find((brain) => brain.id === ref.trim() || brain.name.toLowerCase() === key) ?? null;
  },

  /** The repo brain learned from this source (same GitHub repo or same folder), if any. */
  forSource(source: string): Brain | null {
    const fullName = githubFullName(source)?.toLowerCase();
    const folder = source.trim().replace(/[/\\]+$/, "");
    return (
      brains
        .list()
        .find(
          (brain) =>
            brain.kind === "repo" &&
            brain.source &&
            (fullName ? githubFullName(brain.source)?.toLowerCase() === fullName : brain.source.replace(/[/\\]+$/, "") === folder),
        ) ?? null
    );
  },

  create(input: BrainInput & { kind?: Exclude<BrainKind, "notebook">; source?: string | null }): Brain {
    const name = cleanName(input.name);
    if (brains.list().some((brain) => !brain.ownerAgentId && brain.name.toLowerCase() === name.toLowerCase())) {
      throw new BrainError(`There's already a brain called “${name}”.`);
    }
    const id = randomUUID();
    const now = Date.now();
    db.prepare(
      `INSERT INTO brains (id, name, kind, description, source, keywords, all_agents, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      name,
      input.kind ?? "notes",
      cleanDescription(input.description),
      input.source ?? null,
      JSON.stringify(cleanKeywords(input.keywords)),
      input.allAgents ? 1 : 0,
      now,
      now,
    );
    if (input.agentId) brains.attach(id, input.agentId, "write");
    return brains.get(id)!;
  },

  update(id: string, patch: BrainPatch): Brain {
    const brain = brains.get(id);
    if (!brain) throw new BrainError("Brain not found.");
    if (brain.kind === "notebook" && (patch.name !== undefined || patch.allAgents !== undefined)) {
      throw new BrainError("A notebook stays private to its agent and keeps its name.");
    }
    const name = patch.name === undefined ? brain.name : cleanName(patch.name);
    if (
      name.toLowerCase() !== brain.name.toLowerCase() &&
      brains.list().some((other) => other.id !== id && !other.ownerAgentId && other.name.toLowerCase() === name.toLowerCase())
    ) {
      throw new BrainError(`There's already a brain called “${name}”.`);
    }
    db.prepare(`UPDATE brains SET name = ?, description = ?, keywords = ?, all_agents = ?, updated_at = ? WHERE id = ?`).run(
      name,
      patch.description === undefined ? brain.description : cleanDescription(patch.description),
      JSON.stringify(patch.keywords === undefined ? brain.keywords : cleanKeywords(patch.keywords)),
      (patch.allAgents ?? brain.allAgents) ? 1 : 0,
      Date.now(),
      id,
    );
    return brains.get(id)!;
  },

  /** Hides a shared brain (its pages are kept, like deleted pages). */
  delete(id: string): void {
    const brain = brains.get(id);
    if (!brain) throw new BrainError("Brain not found.");
    if (brain.kind === "notebook") throw new BrainError("An agent's notebook can't be deleted.");
    db.prepare(`UPDATE brains SET deleted_at = ? WHERE id = ?`).run(Date.now(), id);
    db.prepare(`DELETE FROM brain_agents WHERE brain_id = ?`).run(id);
    db.prepare(`UPDATE conversations SET brain_id = NULL WHERE brain_id = ?`).run(id);
  },

  attach(brainId: string, agentId: string, access: BrainAccess): Brain {
    const brain = brains.get(brainId);
    if (!brain) throw new BrainError("Brain not found.");
    if (brain.kind === "notebook") throw new BrainError("A notebook stays private to its agent.");
    if (access !== "read" && access !== "write") throw new BrainError("Access is read or write.");
    db.prepare(
      `INSERT INTO brain_agents (brain_id, agent_id, access) VALUES (?, ?, ?) ON CONFLICT(brain_id, agent_id) DO UPDATE SET access = excluded.access`,
    ).run(brainId, agentId, access);
    return brains.get(brainId)!;
  },

  detach(brainId: string, agentId: string): Brain {
    db.prepare(`DELETE FROM brain_agents WHERE brain_id = ? AND agent_id = ?`).run(brainId, agentId);
    const brain = brains.get(brainId);
    if (!brain) throw new BrainError("Brain not found.");
    return brain;
  },

  /** Shared brains a request or command is about, by their signals (best first: most signals matched). */
  match(agentId: string, text: string): AgentBrain[] {
    if (!text.trim()) return [];
    return brains
      .forAgent(agentId)
      .filter((brain) => brain.kind !== "notebook")
      .map((brain) => ({ brain, hits: brainSignals(brain).filter((pattern) => pattern.test(text)).length }))
      .filter(({ hits }) => hits > 0)
      .sort((a, b) => b.hits - a.hits)
      .map(({ brain }) => brain);
  },

  // A chat's focus brain (where new pages go by default) and the brains it has been pointed at.

  focus(conversationId: string): string | null {
    const row = db.prepare(`SELECT brain_id FROM conversations WHERE id = ?`).get(conversationId) as Row | undefined;
    return (row?.brain_id as string | null) ?? null;
  },

  setFocus(conversationId: string, brainId: string | null): void {
    db.prepare(`UPDATE conversations SET brain_id = ? WHERE id = ?`).run(brainId, conversationId);
  },

  hinted(conversationId: string): Set<string> {
    const row = db.prepare(`SELECT brain_hints FROM conversations WHERE id = ?`).get(conversationId) as Row | undefined;
    return new Set(parseJson<string[]>(row?.brain_hints, []));
  },

  markHinted(conversationId: string, brainIds: string[]): void {
    if (!brainIds.length) return;
    const seen = brains.hinted(conversationId);
    for (const id of brainIds) seen.add(id);
    db.prepare(`UPDATE conversations SET brain_hints = ? WHERE id = ?`).run(JSON.stringify([...seen]), conversationId);
  },
};
