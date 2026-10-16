import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Attachment } from "@tot/shared/types";
import { DATA_DIR } from "../config.ts";
import { db, type Row } from "../db.ts";

/** Files users attach to messages, stored under DATA_DIR/uploads/<id>/<name>. */

export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const ROOT = join(DATA_DIR, "uploads");

export interface UploadRecord extends Attachment {
  path: string;
}

/** Keeps the name readable but safe as a single path segment. */
function safeName(name: string): string {
  const cleaned = name.replace(/[/\\\0]/g, "_").replace(/^\.+/, "").trim().slice(0, 120);
  return cleaned || "file";
}

function toRecord(row: Row): UploadRecord {
  const id = String(row.id);
  const name = String(row.name);
  return {
    id,
    name,
    mimeType: String(row.mime_type),
    size: Number(row.size),
    url: `/api/uploads/${id}/${encodeURIComponent(name)}`,
    path: String(row.path),
  };
}

export function toAttachment(record: UploadRecord): Attachment {
  const { path: _p, ...attachment } = record;
  return attachment;
}

export const uploads = {
  save(input: { name: string; mimeType: string; data: Buffer }): UploadRecord {
    const id = randomUUID();
    const name = safeName(input.name);
    const dir = join(ROOT, id);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, input.data);
    db.prepare(`INSERT INTO uploads (id, name, mime_type, size, path, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
      id,
      name,
      input.mimeType || "application/octet-stream",
      input.data.length,
      path,
      Date.now(),
    );
    return uploads.get(id)!;
  },

  get(id: string): UploadRecord | null {
    const row = db.prepare(`SELECT * FROM uploads WHERE id = ?`).get(id) as Row | undefined;
    return row ? toRecord(row) : null;
  },
};
