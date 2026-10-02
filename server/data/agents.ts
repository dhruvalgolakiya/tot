import { randomUUID } from "node:crypto";
import type { Agent, AgentInput, MascotSpec } from "../../shared/types.ts";
import { db, parseJson, type Row } from "../db.ts";
import { getComputerSummary } from "./computers.ts";
import { personas } from "./personas.ts";
import { wiki } from "./wiki.ts";

/** Tot, the agent every install starts with. */
export const DEFAULT_AGENT: AgentInput = {
  name: "Tot",
  mascot: { shape: "blob", color: "#8b7cf6", accessory: "headphones", eyes: "dots" },
  instructions: "",
  modelId: "auto",
};

const FALLBACK_MASCOT: MascotSpec = DEFAULT_AGENT.mascot;

const count = (sql: string, id: string) => Number((db.prepare(sql).get(id) as Row).n);

function toAgent(row: Row): Agent {
  const id = String(row.id);
  return {
    id,
    name: String(row.name),
    mascot: parseJson<MascotSpec>(row.mascot, FALLBACK_MASCOT),
    instructions: String(row.instructions ?? ""),
    modelId: String(row.model_id),
    computer: getComputerSummary(id),
    personaId: (row.persona_id as string | null) ?? null,
    counts: {
      chats: count(`SELECT COUNT(*) AS n FROM conversations WHERE agent_id = ?`, id),
      pages: count(`SELECT COUNT(*) AS n FROM wiki_pages WHERE agent_id = ? AND deleted_at IS NULL`, id),
      routines: count(`SELECT COUNT(*) AS n FROM routines WHERE agent_id = ?`, id),
    },
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export const agents = {
  list(): Agent[] {
    return (db.prepare(`SELECT * FROM agents ORDER BY created_at, rowid`).all() as Row[]).map(toAgent);
  },

  get(id: string): Agent | null {
    const row = db.prepare(`SELECT * FROM agents WHERE id = ?`).get(id) as Row | undefined;
    return row ? toAgent(row) : null;
  },

  /** The first agent; created on demand so there is always one to talk to. */
  first(): Agent {
    const row = db.prepare(`SELECT * FROM agents ORDER BY created_at, rowid LIMIT 1`).get() as Row | undefined;
    return row ? toAgent(row) : agents.create(DEFAULT_AGENT);
  },

  create(input: AgentInput): Agent {
    const id = randomUUID();
    const now = Date.now();
    db.prepare(
      `INSERT INTO agents (id, name, mascot, instructions, model_id, persona_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.name.trim(),
      JSON.stringify(input.mascot),
      input.instructions?.trim() ?? "",
      input.modelId ?? "auto",
      input.personaId ?? null,
      now,
      now,
    );
    wiki.overview(id);
    return agents.get(id)!;
  },

  update(id: string, patch: Partial<AgentInput>): Agent | null {
    const columns: Record<string, string | number | null | undefined> = {
      name: patch.name?.trim(),
      mascot: patch.mascot && JSON.stringify(patch.mascot),
      instructions: patch.instructions?.trim(),
      model_id: patch.modelId,
      // null: back to working as the user.
      persona_id: patch.personaId,
    };
    const entries = Object.entries(columns).filter(([, v]) => v !== undefined);
    if (entries.length) {
      db.prepare(`UPDATE agents SET ${entries.map(([k]) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(
        ...(entries.map(([, v]) => v) as (string | number | null)[]),
        Date.now(),
        id,
      );
    }
    return agents.get(id);
  },

  delete(id: string): void {
    db.prepare(`DELETE FROM agents WHERE id = ?`).run(id);
  },
};

// Every install has at least Tot, and chats from before agents existed belong to it.
db.prepare(`UPDATE conversations SET agent_id = ? WHERE agent_id IS NULL`).run(agents.first().id);

const SHAPES = new Set(["blob", "cloud", "pear", "star", "heart", "drop", "bot", "ghost", "frog", "cat"]);
const ACCESSORIES = new Set(["none", "glasses", "sunglasses", "bowtie", "beret", "headphones", "cap", "antenna", "crown", "scarf"]);
const EYES = new Set(["dots", "happy", "wide", "sleepy"]);

export function validateAgent(input: Partial<AgentInput>, creating: boolean): string | null {
  if (creating || input.name !== undefined) {
    const name = input.name?.trim() ?? "";
    if (!name) return "Give your agent a name.";
    if (name.length > 40) return "Agent names can be at most 40 characters.";
  }
  if (creating && !input.mascot) return "Pick a mascot for your agent.";
  if (input.mascot) {
    const { shape, color, accessory, eyes } = input.mascot;
    if (!SHAPES.has(shape) || !ACCESSORIES.has(accessory) || !EYES.has(eyes)) return "That mascot isn't valid.";
    if (!/^#[0-9a-f]{6}$/i.test(color)) return "Mascot color must look like #a78bfa.";
  }
  if (input.instructions !== undefined && input.instructions.length > 4000) return "Instructions can be at most 4000 characters.";
  if (input.personaId !== undefined && input.personaId !== null) {
    if (typeof input.personaId !== "string" || !personas.exists(input.personaId)) return "That persona doesn't exist.";
  }
  return null;
}
