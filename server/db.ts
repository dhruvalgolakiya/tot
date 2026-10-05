import { randomUUID } from "node:crypto";
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
// (Module 10 rebuilt `memories` as an index without this column; its old rows are in memories_legacy.)
if (!hasColumn("memories", "agent_id") && !hasColumn("memories", "repo")) {
  db.exec(`ALTER TABLE memories ADD COLUMN agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE`);
}

// v6: brains — knowledge bases at the app level. Each agent owns one private
// notebook brain; shared brains are attached to agents (read or write) or to all.
db.exec(`
  CREATE TABLE IF NOT EXISTS brains (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    source TEXT,
    keywords TEXT NOT NULL DEFAULT '[]',
    owner_agent_id TEXT UNIQUE REFERENCES agents(id) ON DELETE CASCADE,
    all_agents INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS brain_agents (
    brain_id TEXT NOT NULL REFERENCES brains(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    access TEXT NOT NULL,
    PRIMARY KEY (brain_id, agent_id)
  );
  CREATE INDEX IF NOT EXISTS brain_agents_by_agent ON brain_agents(agent_id);
`);

export const NOTEBOOK_NAME = "Notebook";
export const NOTEBOOK_DESCRIPTION = "Your own notes: this workspace, the user's work here, and anything no other brain covers.";

// v4: wiki pages (each brain's pages since v6; before that, each agent's).
const WIKI_TRIGGERS = `
  CREATE TRIGGER IF NOT EXISTS wiki_pages_ai AFTER INSERT ON wiki_pages BEGIN
    INSERT INTO wiki_fts(rowid, title, summary, content) VALUES (new.rowid, new.title, new.summary, new.content);
  END;
  CREATE TRIGGER IF NOT EXISTS wiki_pages_ad AFTER DELETE ON wiki_pages BEGIN
    INSERT INTO wiki_fts(wiki_fts, rowid, title, summary, content) VALUES ('delete', old.rowid, old.title, old.summary, old.content);
  END;
  CREATE TRIGGER IF NOT EXISTS wiki_pages_au AFTER UPDATE ON wiki_pages BEGIN
    INSERT INTO wiki_fts(wiki_fts, rowid, title, summary, content) VALUES ('delete', old.rowid, old.title, old.summary, old.content);
    INSERT INTO wiki_fts(rowid, title, summary, content) VALUES (new.rowid, new.title, new.summary, new.content);
  END;`;
const wikiPagesTable = (name: string) => `
  CREATE TABLE IF NOT EXISTS ${name} (
    id TEXT PRIMARY KEY,
    brain_id TEXT NOT NULL REFERENCES brains(id) ON DELETE CASCADE,
    parent_id TEXT REFERENCES wiki_pages(id) ON DELETE SET NULL,
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    pinned INTEGER NOT NULL DEFAULT 0,
    position REAL NOT NULL DEFAULT 0,
    updated_by TEXT NOT NULL,
    conversation_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  );`;
db.exec(`
  ${wikiPagesTable("wiki_pages")}
  CREATE VIRTUAL TABLE IF NOT EXISTS wiki_fts USING fts5(
    title, summary, content, content='wiki_pages', content_rowid='rowid', tokenize='porter unicode61'
  );
  ${WIKI_TRIGGERS}

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

// v6: each agent's wiki becomes its notebook brain. SQLite can't change a column's
// constraints in place, so the pages move to a rebuilt table (same rowids, so the
// search index and revisions carry over) — all or nothing.
if (hasColumn("wiki_pages", "agent_id")) {
  db.exec(`PRAGMA foreign_keys = OFF`);
  db.exec("BEGIN");
  try {
    const now = Date.now();
    for (const row of db.prepare(`SELECT id FROM agents WHERE id NOT IN (SELECT owner_agent_id FROM brains WHERE owner_agent_id IS NOT NULL)`).all() as { id: string }[]) {
      db.prepare(
        `INSERT INTO brains (id, name, kind, description, owner_agent_id, created_at, updated_at) VALUES (?, ?, 'notebook', ?, ?, ?, ?)`,
      ).run(randomUUID(), NOTEBOOK_NAME, NOTEBOOK_DESCRIPTION, row.id, now, now);
    }
    db.exec(`
      DROP TABLE IF EXISTS wiki_pages_v6;
      ${wikiPagesTable("wiki_pages_v6")}
      INSERT INTO wiki_pages_v6 (rowid, id, brain_id, parent_id, title, summary, content, pinned, position, updated_by, conversation_id, created_at, updated_at, deleted_at)
        SELECT p.rowid, p.id, b.id, p.parent_id, p.title, p.summary, p.content, p.pinned, p.position, p.updated_by, p.conversation_id, p.created_at, p.updated_at, p.deleted_at
        FROM wiki_pages p JOIN brains b ON b.owner_agent_id = p.agent_id;
      DROP TRIGGER IF EXISTS wiki_pages_ai;
      DROP TRIGGER IF EXISTS wiki_pages_ad;
      DROP TRIGGER IF EXISTS wiki_pages_au;
      DROP TABLE wiki_pages;
      ALTER TABLE wiki_pages_v6 RENAME TO wiki_pages;
      ${WIKI_TRIGGERS}
      INSERT INTO wiki_fts(wiki_fts) VALUES ('rebuild');
    `);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  } finally {
    db.exec(`PRAGMA foreign_keys = ON`);
  }
}
db.exec(`CREATE INDEX IF NOT EXISTS wiki_pages_by_brain ON wiki_pages(brain_id, parent_id, position)`);

// A chat's focus brain (where new pages go by default), and the brains it has already been pointed at.
if (!hasColumn("conversations", "brain_id")) db.exec(`ALTER TABLE conversations ADD COLUMN brain_id TEXT`);
if (!hasColumn("conversations", "brain_hints")) db.exec(`ALTER TABLE conversations ADD COLUMN brain_hints TEXT NOT NULL DEFAULT '[]'`);

// How far the wiki keeper has read each chat. Chats from before the wiki count as read.
if (!hasColumn("conversations", "wiki_synced_at")) {
  db.exec(`ALTER TABLE conversations ADD COLUMN wiki_synced_at INTEGER NOT NULL DEFAULT 0`);
  db.exec(`UPDATE conversations SET wiki_synced_at = updated_at`);
}

// v5: chats started outside TOT (a Slack thread), and which Slack thread each belongs to.
if (!hasColumn("conversations", "origin")) db.exec(`ALTER TABLE conversations ADD COLUMN origin TEXT`);
db.exec(`
  CREATE TABLE IF NOT EXISTS slack_threads (
    channel TEXT NOT NULL,
    thread_ts TEXT NOT NULL,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    -- The person who started it: the one who may approve its actions from Slack.
    user_id TEXT NOT NULL,
    -- The newest Slack message already shown to the agent, so later turns get only what's new.
    seen_ts TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (channel, thread_ts)
  );
  CREATE INDEX IF NOT EXISTS slack_threads_by_conversation ON slack_threads(conversation_id);
`);

// v6: personas (an identity with a real mailbox that agents work as), their stored mail, and
// which email thread each emailed task's chat belongs to. Mailbox passwords live in secrets.json.
db.exec(`
  CREATE TABLE IF NOT EXISTS personas (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    -- Mailbox settings and state (PersonaMailbox plus the login name), JSON.
    mailbox TEXT NOT NULL DEFAULT '{}',
    -- Where mail syncing left off in each folder (UIDVALIDITY and next UID), JSON.
    mail_sync TEXT,
    allowed_senders TEXT NOT NULL DEFAULT '[]',
    default_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS mail_messages (
    id TEXT PRIMARY KEY,
    persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
    -- 'inbox' or 'sent'; uid is null for mail TOT sent that the server's Sent folder hasn't shown yet.
    folder TEXT NOT NULL,
    uid INTEGER,
    uid_validity TEXT,
    message_id TEXT,
    in_reply_to TEXT,
    refs TEXT NOT NULL DEFAULT '[]',
    thread_id TEXT NOT NULL,
    from_name TEXT,
    from_address TEXT NOT NULL,
    to_addresses TEXT NOT NULL DEFAULT '[]',
    cc_addresses TEXT NOT NULL DEFAULT '[]',
    subject TEXT NOT NULL,
    text TEXT NOT NULL,
    links TEXT NOT NULL DEFAULT '[]',
    codes TEXT NOT NULL DEFAULT '[]',
    attachments TEXT NOT NULL DEFAULT '[]',
    date INTEGER NOT NULL,
    unread INTEGER NOT NULL,
    outgoing INTEGER NOT NULL,
    -- The receiving provider vouched for the sender (DMARC, or DKIM aligned with the From domain).
    authenticated INTEGER NOT NULL DEFAULT 0,
    -- An auto-reply, bounce or bulk/list mail.
    automated INTEGER NOT NULL DEFAULT 0,
    conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS mail_by_persona ON mail_messages(persona_id, date);
  CREATE INDEX IF NOT EXISTS mail_by_thread ON mail_messages(persona_id, thread_id, date);
  CREATE UNIQUE INDEX IF NOT EXISTS mail_unique_uid ON mail_messages(persona_id, folder, uid_validity, uid);
  CREATE INDEX IF NOT EXISTS mail_by_message_id ON mail_messages(persona_id, message_id);
  CREATE VIRTUAL TABLE IF NOT EXISTS mail_fts USING fts5(
    subject, from_name, from_address, text, content='mail_messages', content_rowid='rowid', tokenize='porter unicode61'
  );
  CREATE TRIGGER IF NOT EXISTS mail_messages_ai AFTER INSERT ON mail_messages BEGIN
    INSERT INTO mail_fts(rowid, subject, from_name, from_address, text) VALUES (new.rowid, new.subject, new.from_name, new.from_address, new.text);
  END;
  CREATE TRIGGER IF NOT EXISTS mail_messages_ad AFTER DELETE ON mail_messages BEGIN
    INSERT INTO mail_fts(mail_fts, rowid, subject, from_name, from_address, text) VALUES ('delete', old.rowid, old.subject, old.from_name, old.from_address, old.text);
  END;
  CREATE TRIGGER IF NOT EXISTS mail_messages_au AFTER UPDATE OF subject, from_name, from_address, text ON mail_messages BEGIN
    INSERT INTO mail_fts(mail_fts, rowid, subject, from_name, from_address, text) VALUES ('delete', old.rowid, old.subject, old.from_name, old.from_address, old.text);
    INSERT INTO mail_fts(rowid, subject, from_name, from_address, text) VALUES (new.rowid, new.subject, new.from_name, new.from_address, new.text);
  END;

  CREATE TABLE IF NOT EXISTS mail_threads (
    persona_id TEXT NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    -- The allowed sender who started it: answers go back to them.
    sender TEXT NOT NULL,
    -- Date of the newest email already shown to the agent, so later turns get only what's new.
    seen_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (persona_id, thread_id)
  );
  CREATE INDEX IF NOT EXISTS mail_threads_by_conversation ON mail_threads(conversation_id);
`);
if (!hasColumn("agents", "persona_id")) {
  db.exec(`ALTER TABLE agents ADD COLUMN persona_id TEXT REFERENCES personas(id) ON DELETE SET NULL`);
}
// The persona's own GitHub account (PersonaGitHub plus the account's id), JSON; its token lives in secrets.json.
if (!hasColumn("personas", "github")) db.exec(`ALTER TABLE personas ADD COLUMN github TEXT`);
// The persona's picture: an id in uploads.
if (!hasColumn("personas", "avatar_id")) db.exec(`ALTER TABLE personas ADD COLUMN avatar_id TEXT`);

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

// Messages that were streaming when the server last stopped can never finish. The error says why, and a
// chat's next turn tells its model (module 05).
export const CUT_OFF_BY_RESTART = "Cut off when TOT restarted.";
db.prepare(`UPDATE messages SET status = 'stopped', error = ? WHERE status = 'streaming'`).run(CUT_OFF_BY_RESTART);

// Module 01 (tasks): a conversation is a chat or a task (TaskInfo as JSON), started from a parent chat or not.
// child_results lists a chat's finished tasks its model hasn't been told about yet. Messages get a JSON
// meta column (steered notes, TOT's own "continue" turns).
if (!hasColumn("conversations", "kind")) db.exec(`ALTER TABLE conversations ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat'`);
if (!hasColumn("conversations", "parent_id")) db.exec(`ALTER TABLE conversations ADD COLUMN parent_id TEXT`);
if (!hasColumn("conversations", "task")) db.exec(`ALTER TABLE conversations ADD COLUMN task TEXT`);
if (!hasColumn("conversations", "child_results")) db.exec(`ALTER TABLE conversations ADD COLUMN child_results TEXT NOT NULL DEFAULT '[]'`);
if (!hasColumn("messages", "meta")) db.exec(`ALTER TABLE messages ADD COLUMN meta TEXT`);
db.exec(`
  CREATE INDEX IF NOT EXISTS conversations_by_parent ON conversations(parent_id);
  CREATE INDEX IF NOT EXISTS conversations_by_kind ON conversations(kind, agent_id);
`);

// Module 03 (trust gates & playbooks, server/trust/): each repo brain's profile, gate results
// on base commits (so failures that already exist there don't block), and custom playbooks.
// Built-in playbooks live in code; whether each is on, and the workflow defaults, live in settings.
db.exec(`
  CREATE TABLE IF NOT EXISTS repo_profiles (
    brain_id TEXT PRIMARY KEY REFERENCES brains(id) ON DELETE CASCADE,
    -- RepoProfileInput, JSON
    profile TEXT NOT NULL,
    updated_by TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS gate_baselines (
    -- The repo brain's id, or "<agentId>:<folder>" for a folder no brain covers.
    scope TEXT NOT NULL,
    base_sha TEXT NOT NULL,
    gate TEXT NOT NULL,
    command TEXT NOT NULL,
    status TEXT NOT NULL,
    -- Normalized failure lines, JSON, to tell new failures from ones the base already had.
    failures TEXT NOT NULL DEFAULT '[]',
    output_tail TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (scope, base_sha, gate, command)
  );

  CREATE TABLE IF NOT EXISTS playbooks (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    match TEXT NOT NULL DEFAULT '[]',
    steps TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);

// Module 05 (coordination, server/tasks/wake.ts): a chat whose tasks finished and that hasn't been
// woken about them yet (so a restart still wakes it), and the tokens its wake-up turns used, which
// count toward its mission's token budget.
if (!hasColumn("conversations", "wake_pending")) db.exec(`ALTER TABLE conversations ADD COLUMN wake_pending INTEGER NOT NULL DEFAULT 0`);
if (!hasColumn("conversations", "wake_tokens")) db.exec(`ALTER TABLE conversations ADD COLUMN wake_tokens INTEGER NOT NULL DEFAULT 0`);
// Forks (server/chats/fork.ts): where a chat was forked from, notes brought back from its forks for its
// next turn, and each reply's place in its provider session (so a fork can start there natively).
if (!hasColumn("conversations", "forked_from")) db.exec(`ALTER TABLE conversations ADD COLUMN forked_from TEXT`);
if (!hasColumn("conversations", "merge_notes")) db.exec(`ALTER TABLE conversations ADD COLUMN merge_notes TEXT NOT NULL DEFAULT '[]'`);
if (!hasColumn("messages", "provider_ref")) db.exec(`ALTER TABLE messages ADD COLUMN provider_ref TEXT`);
// Retry-safe starts (server/tasks/requests.ts): the tasks each request id started from a chat, in order.
// They go with the chat; a deleted task keeps its row, so a retry still doesn't start it again.
db.exec(`
  CREATE TABLE IF NOT EXISTS task_requests (
    parent_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    request_id TEXT NOT NULL,
    idx INTEGER NOT NULL,
    task_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (parent_id, request_id, idx)
  );

  -- An agent's paused task queue (server/data/queue-holds.ts): a task failed on repeated provider errors.
  CREATE TABLE IF NOT EXISTS queue_holds (
    agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
    provider TEXT,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

// Projects (roadmap module 06): what the user works on, shared by every agent. A chat (and its tasks) is in
// one project or none.
db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    source TEXT,
    default_branch TEXT,
    instructions TEXT NOT NULL DEFAULT '',
    brain_id TEXT NOT NULL,
    intake TEXT NOT NULL DEFAULT '{}',
    folder_granted_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    archived_at INTEGER
  );
`);
if (!hasColumn("conversations", "project_id")) db.exec(`ALTER TABLE conversations ADD COLUMN project_id TEXT`);
db.exec(`CREATE INDEX IF NOT EXISTS conversations_project ON conversations (project_id, agent_id)`);

// Devices (roadmap module 07): browsers and phones signed in to this device (the cookie holds
// "<id>.<secret>"; only the secret's hash is kept here), and the devices paired with it.
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    secret_hash TEXT NOT NULL,
    label TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );

  -- Devices paired with this one. token_hash is the hash of the token *it* uses to call us; the token we
  -- use to call it is the secret "deviceToken:<id>".
  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    address TEXT NOT NULL DEFAULT '',
    token_hash TEXT NOT NULL UNIQUE,
    paired_at INTEGER NOT NULL,
    last_seen_at INTEGER
  );
`);

// Memory repo (roadmap module 10, server/memory/): memory lives in git repos of markdown (DATA_DIR/memory), and
// `memories` becomes an index of their entries, rebuilt from the files after every commit and at startup. An
// entry's id is unique within its repo only, so the table is rebuilt once without the old primary key; the rows
// from before move to `memories_legacy`, which memory/migrate.ts imports into the "you" repo once (and keeps).
const MEMORY_TRIGGERS = `
  CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
  END;
  CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  END;
  CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
  END;`;
if (!hasColumn("memories", "repo")) {
  db.exec("BEGIN");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS memories_legacy (
        id TEXT PRIMARY KEY, content TEXT NOT NULL, source TEXT NOT NULL, conversation_id TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, agent_id TEXT
      );
      INSERT OR IGNORE INTO memories_legacy (id, content, source, conversation_id, created_at, updated_at, agent_id)
        SELECT id, content, source, conversation_id, created_at, updated_at, agent_id FROM memories;
      DROP TABLE memories;
      CREATE TABLE memories (
        id TEXT NOT NULL,
        repo TEXT NOT NULL,
        path TEXT NOT NULL,
        line INTEGER NOT NULL,
        content TEXT NOT NULL,
        -- 'agent' or 'user'; source_ref is the entry's own source ("tot://c/<id>", "you", "dreaming").
        source TEXT NOT NULL,
        source_ref TEXT,
        conversation_id TEXT,
        -- A line someone wrote without an id: its id is derived from its file and text.
        derived INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      ${MEMORY_TRIGGERS}
      INSERT INTO memories_fts(memories_fts) VALUES ('rebuild');
    `);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
db.exec(`
  CREATE INDEX IF NOT EXISTS memories_by_repo ON memories(repo, path, line);
  CREATE INDEX IF NOT EXISTS memories_by_id ON memories(id);
`);

export type Row = Record<string, string | number | bigint | null | Uint8Array>;

export function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || !value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
