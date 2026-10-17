import type { ProviderId } from "@tot/shared/types";
import { dirExists } from "../accounts/accounts.ts";
import type { ConversationRecord } from "../data/conversations.ts";
import { statement, type Row } from "../db.ts";

/** A session imported as a chat (the session_imports table). */
export interface SessionImport {
  conversationId: string;
  projectId: string | null;
  driver: ProviderId;
  sessionId: string;
  account: string;
  /** Where it was found. */
  sourcePath: string;
  /** Where its CLI keeps it now: the same file, or the copy in the account's folder. */
  sessionPath: string;
  cwd: string;
  lastActivityAt: number;
  importedAt: number;
}

function toImport(row: Row): SessionImport {
  return {
    conversationId: String(row.conversation_id),
    projectId: (row.project_id as string | null) ?? null,
    driver: row.driver as ProviderId,
    sessionId: String(row.session_id),
    account: String(row.account),
    sourcePath: String(row.source_path),
    sessionPath: String(row.session_path),
    cwd: String(row.cwd),
    lastActivityAt: Number(row.last_activity_at),
    importedAt: Number(row.imported_at),
  };
}

export const sessionImports = {
  /** Records an import; false when that session was imported already (it never is twice). */
  add(record: SessionImport): boolean {
    const { changes } = statement(
      `INSERT OR IGNORE INTO session_imports (conversation_id, project_id, driver, session_id, account, source_path, session_path, cwd, last_activity_at, imported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.conversationId,
      record.projectId,
      record.driver,
      record.sessionId,
      record.account,
      record.sourcePath,
      record.sessionPath,
      record.cwd,
      record.lastActivityAt,
      record.importedAt,
    );
    return changes > 0;
  },

  forChat(conversationId: string): SessionImport | null {
    const row = statement(`SELECT * FROM session_imports WHERE conversation_id = ?`).get(conversationId) as Row | undefined;
    return row ? toImport(row) : null;
  },

  /** The chat a session became, by "<driver>:<session id>". */
  chats(): Map<string, string> {
    const rows = statement(`SELECT driver, session_id, conversation_id FROM session_imports`).all() as Row[];
    return new Map(rows.map((row) => [`${row.driver}:${row.session_id}`, String(row.conversation_id)]));
  },

  /** When a session was last imported into the project; null before the first. */
  lastImportAt(projectId: string): number | null {
    const row = statement(`SELECT max(imported_at) AS at FROM session_imports WHERE project_id = ?`).get(projectId) as Row | undefined;
    return row?.at === null || row?.at === undefined ? null : Number(row.at);
  },

  /**
   * The folder an imported chat's turns run in: the one its session ran in, where the CLI files it. Only while the
   * chat still continues that session (after a fresh start it's TOT's own) and the folder is still there.
   */
  workDir(chat: Pick<ConversationRecord, "id" | "provider" | "providerSessionId">): string | null {
    if (!chat.providerSessionId) return null;
    const record = sessionImports.forChat(chat.id);
    if (!record || record.driver !== chat.provider || record.sessionId !== chat.providerSessionId) return null;
    return dirExists(record.cwd) ? record.cwd : null;
  },
};
