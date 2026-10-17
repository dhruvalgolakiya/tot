import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

/** A record of a session file, read loosely: the CLIs' formats change between versions, so every field is optional. */
export type SessionRecord = Record<string, any>;

/**
 * A JSONL session file's records, streamed: a long session runs to hundreds of MB, so it's never read whole. Lines
 * that aren't JSON objects are skipped. Stopping early (break) closes the file.
 */
export async function* records(path: string): AsyncGenerator<SessionRecord> {
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.startsWith("{")) continue;
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      if (value && typeof value === "object" && !Array.isArray(value)) yield value as SessionRecord;
    }
  } finally {
    lines.close();
    input.destroy();
  }
}

/** Epoch ms of a record's ISO timestamp; 0 when it has none. */
export function timeOf(record: SessionRecord): number {
  const value = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
  return Number.isFinite(value) ? value : 0;
}
