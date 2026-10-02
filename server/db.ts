import { DatabaseSync } from "node:sqlite";
import { paths } from "./config.ts";

export const db = new DatabaseSync(paths.db);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;

  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT 'New chat',
    model_id TEXT NOT NULL DEFAULT 'auto',
    provider TEXT,
    provider_session_id TEXT,
    -- System prompt frozen at the first turn so the provider's prompt cache stays warm.
    system_prompt TEXT,
    pinned INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    parts TEXT NOT NULL,
    status TEXT NOT NULL,
    provider TEXT,
    model TEXT,
    route_reason TEXT,
    error TEXT,
    usage TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS messages_by_conversation ON messages(conversation_id, created_at);

  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    source TEXT NOT NULL,
    conversation_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    content, content='memories', content_rowid='rowid', tokenize='porter unicode61'
  );
  CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
  END;
  CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  END;
  CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
  END;

  CREATE TABLE IF NOT EXISTS plugins (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    config TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    providers TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    mascot TEXT NOT NULL,
    instructions TEXT NOT NULL DEFAULT '',
    model_id TEXT NOT NULL DEFAULT 'auto',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS routines (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    prompt TEXT NOT NULL,
    schedule TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run_at INTEGER,
    next_run_at INTEGER,
    last_conversation_id TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS uploads (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    path TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

const hasColumn = (table: string, column: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);

// v2: chats belong to agents, and each agent (not each chat) owns a computer.
if (!hasColumn("conversations", "agent_id")) {
  db.exec(`ALTER TABLE conversations ADD COLUMN agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE`);
}
if (hasColumn("computers", "conversation_id")) db.exec(`DROP TABLE computers`);
if (!hasColumn("conversations", "routine_id")) db.exec(`ALTER TABLE conversations ADD COLUMN routine_id TEXT`);

// v3: memories briefly belonged to agent workspaces (agent_id); those moved into each
// workspace's wiki (see data/wiki.ts), and memories are now only about the user.
if (!hasColumn("memories", "agent_id")) {
  db.exec(`ALTER TABLE memories ADD COLUMN agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE`);
}

// v4: each agent's workspace wiki.
db.exec(`
  CREATE TABLE IF NOT EXISTS wiki_pages (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    parent_id TEXT REFERENCES wiki_pages(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    pinned INTEGER NOT NULL DEFAULT 0,
    position REAL NOT NULL DEFAULT 0,
    updated_by TEXT NOT NULL,
    conversation_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS wiki_pages_by_agent ON wiki_pages(agent_id, parent_id, position);
  CREATE VIRTUAL TABLE IF NOT EXISTS wiki_fts USING fts5(
    title, summary, content, content='wiki_pages', content_rowid='rowid', tokenize='porter unicode61'
  );
  CREATE TRIGGER IF NOT EXISTS wiki_pages_ai AFTER INSERT ON wiki_pages BEGIN
    INSERT INTO wiki_fts(rowid, title, summary, content) VALUES (new.rowid, new.title, new.summary, new.content);
  END;
  CREATE TRIGGER IF NOT EXISTS wiki_pages_ad AFTER DELETE ON wiki_pages BEGIN
    INSERT INTO wiki_fts(wiki_fts, rowid, title, summary, content) VALUES ('delete', old.rowid, old.title, old.summary, old.content);
  END;
  CREATE TRIGGER IF NOT EXISTS wiki_pages_au AFTER UPDATE ON wiki_pages BEGIN
    INSERT INTO wiki_fts(wiki_fts, rowid, title, summary, content) VALUES ('delete', old.rowid, old.title, old.summary, old.content);
    INSERT INTO wiki_fts(rowid, title, summary, content) VALUES (new.rowid, new.title, new.summary, new.content);
  END;

  CREATE TABLE IF NOT EXISTS wiki_revisions (
    id TEXT PRIMARY KEY,
    page_id TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    content TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    conversation_id TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS wiki_revisions_by_page ON wiki_revisions(page_id, created_at);
`);

// Deleted wiki pages are kept (with their history) so a deletion can be undone.
if (!hasColumn("wiki_pages", "deleted_at")) db.exec(`ALTER TABLE wiki_pages ADD COLUMN deleted_at INTEGER`);

// How far the wiki keeper has read each chat. Chats from before the wiki count as read.
if (!hasColumn("conversations", "wiki_synced_at")) {
  db.exec(`ALTER TABLE conversations ADD COLUMN wiki_synced_at INTEGER NOT NULL DEFAULT 0`);
  db.exec(`UPDATE conversations SET wiki_synced_at = updated_at`);
}

// Full-text index of what was said in each chat, so agents can search their earlier chats.
db.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS message_search USING fts5(
    text, message_id UNINDEXED, conversation_id UNINDEXED, tokenize='porter unicode61'
  );
  CREATE TRIGGER IF NOT EXISTS message_search_ad AFTER DELETE ON messages BEGIN
    DELETE FROM message_search WHERE message_id = old.id;
  END;
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS conversations_by_agent ON conversations(agent_id, updated_at);

  CREATE TABLE IF NOT EXISTS computers (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL UNIQUE REFERENCES agents(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    external_id TEXT,
    state TEXT NOT NULL,
    label TEXT NOT NULL,
    desktop_url TEXT,
    workspace_path TEXT,
    exposed_urls TEXT NOT NULL DEFAULT '[]',
    screenshot_url TEXT,
    error TEXT,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );
`);

// Messages that were streaming when the server last stopped can never finish.
db.exec(`UPDATE messages SET status = 'stopped' WHERE status = 'streaming'`);

export type Row = Record<string, string | number | bigint | null | Uint8Array>;

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
