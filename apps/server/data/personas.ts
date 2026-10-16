import { randomUUID } from "node:crypto";
import type { Persona, PersonaGitHub, PersonaInput, PersonaMailbox, PersonaPatch } from "../../shared/types.ts";
import { db, parseJson, type Row } from "../db.ts";
import { mail } from "./mail.ts";
import { uploads } from "./uploads.ts";

/**
 * Personas: identities agents work as (a name, a real mailbox and optionally a GitHub account).
 * The mailbox's settings and state and the GitHub account's profile are stored with the persona;
 * the mailbox password and GitHub token live in secrets.json (see mail/ and persona-github.ts).
 */

/** What's stored about the mailbox: what the UI sees, plus the login name when it isn't the address. */
export interface StoredMailbox extends PersonaMailbox {
  username: string | null;
}

/** What's stored about the GitHub account: what the UI sees, plus the account's id (for its noreply address). */
export interface StoredPersonaGitHub extends PersonaGitHub {
  id: number;
}

/** Where mail syncing left off in a folder. */
export interface MailCursor {
  validity: string;
  next: number;
}

/** Sync progress, for the address it was made with (a different address starts over). */
export interface MailSync {
  address: string;
  inbox?: MailCursor;
  sent?: MailCursor;
}

export const EMPTY_MAILBOX: StoredMailbox = {
  state: "not-connected",
  error: null,
  provider: null,
  imap: null,
  smtp: null,
  checkedAt: null,
  username: null,
};

function readMailbox(row: Row): StoredMailbox {
  return { ...EMPTY_MAILBOX, ...parseJson<Partial<StoredMailbox>>(row.mailbox, {}) };
}

const readGitHub = (row: Row) => parseJson<StoredPersonaGitHub | null>(row.github, null);

function toPersona(row: Row): Persona {
  const id = String(row.id);
  const { username: _username, ...mailbox } = readMailbox(row);
  const agentRows = db.prepare(`SELECT id FROM agents WHERE persona_id = ? ORDER BY created_at, rowid`).all(id) as Row[];
  const unread = db.prepare(`SELECT COUNT(*) AS n FROM mail_messages WHERE persona_id = ? AND folder = 'inbox' AND unread = 1`).get(id) as Row;
  const stored = readGitHub(row);
  let github: PersonaGitHub | null = null;
  if (stored) {
    const { id: _githubId, ...rest } = stored;
    github = rest;
  }
  const avatar = row.avatar_id ? uploads.get(String(row.avatar_id)) : null;
  return {
    id,
    name: String(row.name),
    email: String(row.email),
    avatarUrl: avatar?.url ?? null,
    mailbox,
    github,
    allowedSenders: parseJson<string[]>(row.allowed_senders, []),
    defaultAgentId: (row.default_agent_id as string | null) ?? null,
    agentIds: agentRows.map((r) => String(r.id)),
    unread: Number(unread.n),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

const getRow = (id: string) => db.prepare(`SELECT * FROM personas WHERE id = ?`).get(id) as Row | undefined;

export const personas = {
  list(): Persona[] {
    return (db.prepare(`SELECT * FROM personas ORDER BY created_at, rowid`).all() as Row[]).map(toPersona);
  },

  get(id: string): Persona | null {
    const row = getRow(id);
    return row ? toPersona(row) : null;
  },

  exists(id: string): boolean {
    return Boolean(getRow(id));
  },

  /** The id of the persona an agent works as, if any. */
  idForAgent(agentId: string): string | null {
    const row = db.prepare(`SELECT persona_id FROM agents WHERE id = ?`).get(agentId) as Row | undefined;
    return row?.persona_id ? String(row.persona_id) : null;
  },

  /** The persona an agent works as, if any. */
  forAgent(agentId: string): Persona | null {
    const id = personas.idForAgent(agentId);
    return id ? personas.get(id) : null;
  },

  create(input: PersonaInput): Persona {
    const id = randomUUID();
    const now = Date.now();
    db.prepare(`INSERT INTO personas (id, name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`).run(
      id,
      input.name.trim(),
      input.email.trim().toLowerCase(),
      now,
      now,
    );
    return personas.get(id)!;
  },

  update(id: string, patch: PersonaPatch): Persona | null {
    const columns: Record<string, string | null | undefined> = {
      name: patch.name?.trim(),
      email: patch.email?.trim().toLowerCase(),
      avatar_id: patch.avatarId,
      allowed_senders: patch.allowedSenders && JSON.stringify(patch.allowedSenders),
      default_agent_id: patch.defaultAgentId,
    };
    const entries = Object.entries(columns).filter(([, v]) => v !== undefined);
    if (entries.length) {
      db.prepare(`UPDATE personas SET ${entries.map(([k]) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(
        ...(entries.map(([, v]) => v) as (string | null)[]),
        Date.now(),
        id,
      );
    }
    return personas.get(id);
  },

  /** Forgets its stored mail too; agents working as it go back to working as the user. */
  delete(id: string): void {
    mail.clear(id);
    db.prepare(`UPDATE agents SET persona_id = NULL WHERE persona_id = ?`).run(id);
    db.prepare(`DELETE FROM personas WHERE id = ?`).run(id);
  },

  mailbox(id: string): StoredMailbox {
    const row = getRow(id);
    return row ? readMailbox(row) : { ...EMPTY_MAILBOX };
  },

  setMailbox(id: string, patch: Partial<StoredMailbox>): void {
    const row = getRow(id);
    if (row) db.prepare(`UPDATE personas SET mailbox = ? WHERE id = ?`).run(JSON.stringify({ ...readMailbox(row), ...patch }), id);
  },

  /** The persona's own GitHub account, without its token. */
  githubAccount(id: string): StoredPersonaGitHub | null {
    const row = getRow(id);
    return row ? readGitHub(row) : null;
  },

  setGitHubAccount(id: string, account: StoredPersonaGitHub | null): void {
    db.prepare(`UPDATE personas SET github = ? WHERE id = ?`).run(account ? JSON.stringify(account) : null, id);
  },

  sync(id: string): MailSync | null {
    return parseJson<MailSync | null>(getRow(id)?.mail_sync, null);
  },

  setSync(id: string, sync: MailSync | null): void {
    db.prepare(`UPDATE personas SET mail_sync = ? WHERE id = ?`).run(sync ? JSON.stringify(sync) : null, id);
  },
};

const EMAIL = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/;

export const isEmail = (value: string) => EMAIL.test(value) && value.length <= 254;

export function validatePersona(input: Partial<PersonaInput & PersonaPatch>, creating: boolean): string | null {
  if (creating || input.name !== undefined) {
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name) return "Give the persona a name.";
    if (name.length > 60) return "Persona names can be at most 60 characters.";
  }
  if (creating || input.email !== undefined) {
    const email = typeof input.email === "string" ? input.email.trim() : "";
    if (!isEmail(email)) return "Enter the persona's email address, e.g. tot.agent@gmail.com.";
  }
  if (input.allowedSenders !== undefined) {
    if (!Array.isArray(input.allowedSenders) || input.allowedSenders.length > 100) return "Allowed senders must be a list of up to 100 addresses.";
    const bad = input.allowedSenders.find((sender) => typeof sender !== "string" || !isEmail(sender.trim()));
    if (bad !== undefined) return `“${String(bad)}” isn't an email address.`;
  }
  if (input.defaultAgentId !== undefined && input.defaultAgentId !== null && typeof input.defaultAgentId !== "string") {
    return "The default agent must be an agent id or null.";
  }
  if (input.avatarId !== undefined && input.avatarId !== null && typeof input.avatarId !== "string") {
    return "The picture must be an uploaded file's id or null.";
  }
  return null;
}
