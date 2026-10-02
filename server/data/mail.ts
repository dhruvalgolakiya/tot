import { randomUUID } from "node:crypto";
import type { MailAddress, MailMessage, MailSummary } from "../../shared/types.ts";
import { db, parseJson, type Row } from "../db.ts";

/** Personas' stored mail (recent INBOX and Sent), searchable by sender, subject and text. */

export type MailFolder = "inbox" | "sent";

/** A stored email, with what TOT keeps for syncing, threading and deciding what counts as a task. */
export interface StoredMail extends MailMessage {
  folder: MailFolder;
  uid: number | null;
  uidValidity: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  /** The receiving provider vouched for the sender (DMARC, or DKIM aligned with the From domain). */
  authenticated: boolean;
  /** An auto-reply, bounce or bulk/list mail. */
  automated: boolean;
  createdAt: number;
}

export type NewMail = Omit<StoredMail, "id" | "conversationId" | "createdAt" | "snippet" | "hasAttachments">;

const SNIPPET_CHARS = 200;
/** Lists carry only the start of each email's text (enough for the snippet). */
const LIST_TEXT_CHARS = 600;

const snippet = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > SNIPPET_CHARS ? `${flat.slice(0, SNIPPET_CHARS - 1)}…` : flat;
};

function toStored(row: Row): StoredMail {
  const text = String(row.text ?? "");
  const attachments = parseJson<StoredMail["attachments"]>(row.attachments, []);
  return {
    id: String(row.id),
    personaId: String(row.persona_id),
    threadId: String(row.thread_id),
    from: { name: (row.from_name as string | null) ?? null, address: String(row.from_address) },
    to: parseJson<MailAddress[]>(row.to_addresses, []),
    cc: parseJson<MailAddress[]>(row.cc_addresses, []),
    subject: String(row.subject),
    snippet: snippet(text),
    text,
    date: Number(row.date),
    unread: Boolean(row.unread),
    outgoing: Boolean(row.outgoing),
    codes: parseJson<string[]>(row.codes, []),
    links: parseJson<StoredMail["links"]>(row.links, []),
    attachments,
    hasAttachments: attachments.length > 0,
    conversationId: (row.conversation_id as string | null) ?? null,
    folder: row.folder as MailFolder,
    uid: row.uid == null ? null : Number(row.uid),
    uidValidity: (row.uid_validity as string | null) ?? null,
    messageId: (row.message_id as string | null) ?? null,
    inReplyTo: (row.in_reply_to as string | null) ?? null,
    references: parseJson<string[]>(row.refs, []),
    authenticated: Boolean(row.authenticated),
    automated: Boolean(row.automated),
    createdAt: Number(row.created_at),
  };
}

export function toSummary(mail: StoredMail): MailSummary {
  const { id, personaId, threadId, from, to, subject, snippet, date, unread, outgoing, codes, hasAttachments } = mail;
  return { id, personaId, threadId, from, to, subject, snippet, date, unread, outgoing, codes, hasAttachments };
}

export function toMailMessage(mail: StoredMail): MailMessage {
  return { ...toSummary(mail), cc: mail.cc, text: mail.text, links: mail.links, attachments: mail.attachments, conversationId: mail.conversationId };
}

/** Every word must match (prefix-matched): searching mail is about narrowing down. */
function ftsQuery(text: string): string | null {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu);
  if (!words?.length) return null;
  return [...new Set(words)].slice(0, 12).map((word) => `"${word}"*`).join(" ");
}

const LIST_COLUMNS = `m.id, m.persona_id, m.folder, m.uid, m.uid_validity, m.message_id, m.in_reply_to, m.refs, m.thread_id,
  m.from_name, m.from_address, m.to_addresses, m.cc_addresses, m.subject, substr(m.text, 1, ${LIST_TEXT_CHARS}) AS text,
  m.links, m.codes, m.attachments, m.date, m.unread, m.outgoing, m.authenticated, m.automated, m.conversation_id, m.created_at`;

export interface MailQuery {
  /** Words to find in the sender, subject or text. */
  q?: string;
  /** Part of the sender's name or address. */
  from?: string;
  /** Sent on or after (ms). */
  since?: number;
  /** Stored by TOT on or after (ms). */
  storedSince?: number;
  unreadOnly?: boolean;
  /** Only mail to the persona (not mail it sent). */
  incomingOnly?: boolean;
  limit?: number;
}

export const mail = {
  /** Newest first; each email's text is cut to its start. */
  list(personaId: string, query: MailQuery = {}): StoredMail[] {
    const where = ["m.persona_id = ?"];
    const args: (string | number)[] = [personaId];
    const fts = query.q?.trim() ? ftsQuery(query.q) : null;
    if (query.q?.trim() && !fts) return [];
    if (fts) {
      where.push("mail_fts MATCH ?");
      args.push(fts);
    }
    if (query.from?.trim()) {
      const like = `%${query.from.trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      where.push(`(lower(m.from_address) LIKE ? ESCAPE '\\' OR lower(coalesce(m.from_name, '')) LIKE ? ESCAPE '\\')`);
      args.push(like, like);
    }
    if (query.since) {
      where.push("m.date >= ?");
      args.push(query.since);
    }
    if (query.storedSince) {
      where.push("m.created_at >= ?");
      args.push(query.storedSince);
    }
    if (query.unreadOnly) where.push("m.unread = 1");
    if (query.incomingOnly) where.push("m.outgoing = 0 AND m.folder = 'inbox'");
    const from = fts ? "mail_fts f JOIN mail_messages m ON m.rowid = f.rowid" : "mail_messages m";
    const rows = db
      .prepare(`SELECT ${LIST_COLUMNS} FROM ${from} WHERE ${where.join(" AND ")} ORDER BY m.date DESC, m.rowid DESC LIMIT ?`)
      .all(...args, Math.min(Math.max(query.limit ?? 50, 1), 500)) as Row[];
    return rows.map(toStored);
  },

  get(personaId: string, id: string): StoredMail | null {
    const row = db.prepare(`SELECT * FROM mail_messages WHERE id = ? AND persona_id = ?`).get(id, personaId) as Row | undefined;
    return row ? toStored(row) : null;
  },

  byUid(personaId: string, folder: MailFolder, validity: string, uid: number): StoredMail | null {
    const row = db
      .prepare(`SELECT * FROM mail_messages WHERE persona_id = ? AND folder = ? AND uid = ? AND uid_validity = ?`)
      .get(personaId, folder, uid, validity) as Row | undefined;
    return row ? toStored(row) : null;
  },

  byMessageId(personaId: string, messageId: string): StoredMail | null {
    const row = db
      .prepare(`SELECT * FROM mail_messages WHERE persona_id = ? AND message_id = ? ORDER BY rowid LIMIT 1`)
      .get(personaId, messageId) as Row | undefined;
    return row ? toStored(row) : null;
  },

  /** The thread of the first of these Message-IDs TOT has stored, if any. */
  threadOf(personaId: string, messageIds: string[]): string | null {
    for (const id of messageIds) {
      const found = mail.byMessageId(personaId, id);
      if (found) return found.threadId;
    }
    return null;
  },

  /** A thread's emails, oldest first. */
  thread(personaId: string, threadId: string): StoredMail[] {
    const rows = db
      .prepare(`SELECT * FROM mail_messages WHERE persona_id = ? AND thread_id = ? ORDER BY date, rowid`)
      .all(personaId, threadId) as Row[];
    return rows.map(toStored);
  },

  /** Null when it's already stored (same folder, UIDVALIDITY and UID), e.g. by a sync that overlapped. */
  insert(input: NewMail): StoredMail | null {
    const id = randomUUID();
    const { changes } = db.prepare(
      `INSERT OR IGNORE INTO mail_messages (id, persona_id, folder, uid, uid_validity, message_id, in_reply_to, refs, thread_id, from_name,
         from_address, to_addresses, cc_addresses, subject, text, links, codes, attachments, date, unread, outgoing, authenticated,
         automated, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.personaId,
      input.folder,
      input.uid,
      input.uidValidity,
      input.messageId,
      input.inReplyTo,
      JSON.stringify(input.references),
      input.threadId,
      input.from.name,
      input.from.address,
      JSON.stringify(input.to),
      JSON.stringify(input.cc),
      input.subject,
      input.text,
      JSON.stringify(input.links),
      JSON.stringify(input.codes),
      JSON.stringify(input.attachments),
      input.date,
      Number(input.unread),
      Number(input.outgoing),
      Number(input.authenticated),
      Number(input.automated),
      Date.now(),
    );
    return changes ? mail.get(input.personaId, id) : null;
  },

  /** A copy TOT stored when sending turned up in the server's Sent folder. */
  attachUid(id: string, folder: MailFolder, validity: string, uid: number): void {
    db.prepare(`UPDATE mail_messages SET folder = ?, uid_validity = ?, uid = ? WHERE id = ?`).run(folder, validity, uid, id);
  },

  setUnread(id: string, unread: boolean): boolean {
    return db.prepare(`UPDATE mail_messages SET unread = ? WHERE id = ? AND unread != ?`).run(Number(unread), id, Number(unread)).changes > 0;
  },

  setConversation(id: string, conversationId: string): void {
    db.prepare(`UPDATE mail_messages SET conversation_id = ? WHERE id = ?`).run(conversationId, id);
  },

  /** UIDs of the newest stored emails in a folder, to mirror reads done elsewhere. */
  newestUids(personaId: string, folder: MailFolder, validity: string, limit: number): number[] {
    const rows = db
      .prepare(`SELECT uid FROM mail_messages WHERE persona_id = ? AND folder = ? AND uid_validity = ? AND uid IS NOT NULL ORDER BY uid DESC LIMIT ?`)
      .all(personaId, folder, validity, limit) as Row[];
    return rows.map((row) => Number(row.uid));
  },

  /** Mirrors the server's \Seen flags; true when anything changed. */
  mirrorSeen(personaId: string, folder: MailFolder, validity: string, seen: Map<number, boolean>): boolean {
    const update = db.prepare(
      `UPDATE mail_messages SET unread = ? WHERE persona_id = ? AND folder = ? AND uid_validity = ? AND uid = ? AND outgoing = 0 AND unread != ?`,
    );
    let changed = false;
    for (const [uid, isSeen] of seen) {
      if (update.run(Number(!isSeen), personaId, folder, validity, uid, Number(!isSeen)).changes) changed = true;
    }
    return changed;
  },

  /** Keeps only the newest `keep` emails. */
  prune(personaId: string, keep: number): void {
    db.prepare(
      `DELETE FROM mail_messages WHERE persona_id = ? AND id NOT IN (SELECT id FROM mail_messages WHERE persona_id = ? ORDER BY date DESC, rowid DESC LIMIT ?)`,
    ).run(personaId, personaId, keep);
  },

  /** Forgets a persona's stored mail and which chats its threads belong to. */
  clear(personaId: string): void {
    db.prepare(`DELETE FROM mail_threads WHERE persona_id = ?`).run(personaId);
    db.prepare(`DELETE FROM mail_messages WHERE persona_id = ?`).run(personaId);
  },
};
