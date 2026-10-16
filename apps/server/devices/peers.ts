import { createHash, randomBytes } from "node:crypto";
import { getSecret, setSecret } from "../config.ts";
import { db, type Row } from "../db.ts";
import { safeEqual } from "../session.ts";

/**
 * Devices paired with this one (roadmap module 07). Each pair holds two tokens: one each device uses
 * to call the other. We keep the hash of the one it uses to call us, and the one we use to call it
 * as the secret "deviceToken:<id>" (secrets.json, 0600). Tokens never go into logs or responses.
 */

export const DEVICE_TOKEN_PREFIX = "totd_";

export interface Peer {
  id: string;
  name: string;
  /** Where we reach it; "" when it gave no address (pairing works one way). */
  address: string;
  pairedAt: number;
  lastSeenAt: number | null;
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

export const newDeviceToken = () => `${DEVICE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;

const toPeer = (row: Row): Peer => ({
  id: String(row.id),
  name: String(row.name),
  address: String(row.address),
  pairedAt: Number(row.paired_at),
  lastSeenAt: row.last_seen_at === null ? null : Number(row.last_seen_at),
});

export const peers = {
  list(): Peer[] {
    return (db.prepare(`SELECT * FROM devices ORDER BY paired_at`).all() as Row[]).map(toPeer);
  },

  get(id: string): Peer | null {
    const row = db.prepare(`SELECT * FROM devices WHERE id = ?`).get(id) as Row | undefined;
    return row ? toPeer(row) : null;
  },

  /**
   * Saves a pairing, replacing an earlier one with the same device. `inbound` is the token it will use
   * to call us; `outbound` the one we use to call it.
   */
  save(peer: { id: string; name: string; address: string }, tokens: { inbound: string; outbound: string }) {
    db.prepare(
      `INSERT INTO devices (id, name, address, token_hash, paired_at, last_seen_at) VALUES (?, ?, ?, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, address = excluded.address, token_hash = excluded.token_hash,
         paired_at = excluded.paired_at, last_seen_at = NULL`,
    ).run(peer.id, peer.name, peer.address, hash(tokens.inbound), Date.now());
    setSecret(`deviceToken:${peer.id}`, tokens.outbound);
  },

  /** The paired device a bearer token belongs to. */
  byToken(token: string): string | null {
    if (!token.startsWith(DEVICE_TOKEN_PREFIX)) return null;
    const digest = hash(token);
    const row = db.prepare(`SELECT id, token_hash FROM devices WHERE token_hash = ?`).get(digest) as Row | undefined;
    return row && safeEqual(String(row.token_hash), digest) ? String(row.id) : null;
  },

  /** The token for calling it. */
  tokenFor(id: string): string | undefined {
    return getSecret(`deviceToken:${id}`);
  },

  update(id: string, patch: { name?: string; address?: string; lastSeenAt?: number }) {
    if (patch.name !== undefined) db.prepare(`UPDATE devices SET name = ? WHERE id = ?`).run(patch.name, id);
    if (patch.address !== undefined) db.prepare(`UPDATE devices SET address = ? WHERE id = ?`).run(patch.address, id);
    if (patch.lastSeenAt !== undefined) db.prepare(`UPDATE devices SET last_seen_at = ? WHERE id = ?`).run(patch.lastSeenAt, id);
  },

  remove(id: string) {
    db.prepare(`DELETE FROM devices WHERE id = ?`).run(id);
    setSecret(`deviceToken:${id}`, "");
  },
};
