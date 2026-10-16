import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryPeerSync, MemoryRemoteStatus, MemorySyncStatus } from "@tot/shared/types";
import { appEvents } from "../app-events.ts";
import { DATA_DIR } from "../config.ts";
import { db, parseJson, type Row } from "../db.ts";
import { settings } from "../data/settings.ts";
import { deviceId } from "../devices/identity.ts";
import { peers, type Peer } from "../devices/peers.ts";
import { relay } from "../devices/relay.ts";
import { hideSecrets } from "../trust/secrets.ts";
import { afterChange, ensureRepo } from "./memory.ts";
import { commitOutsideEdits, git, GitError, head, initRepo, mergeRef, repoDir, subjectText, withRepo, YOU } from "./repo.ts";

/**
 * Memory that follows you (roadmap module 10). The "you" repo syncs with paired devices, no GitHub needed:
 *  - each device serves its repo as a git bundle at GET /api/memory/sync/you.bundle, to paired devices only;
 *  - every 10 minutes, soon after a paired device says its memory changed, and when one comes online, this device
 *    fetches that device's bundle (at most 50 MB, objects checked) into refs/peers/<deviceId> and brings it in
 *    (entry by entry for markdown, repo.ts; only memory files come in). Both sides pull, so they converge. Of
 *    each pair only one device merges (the one with the smaller id, or the one the other can't reach); the other
 *    fast-forwards to its merge, and says it's waiting meanwhile. Two devices merging each other at once would
 *    otherwise make different merges and go round again; after 30 minutes of waiting, this one merges anyway.
 * Optionally the repo is also backed up to a private git remote the user set up (`memory.remote`): fetch, merge,
 * push, soon after each change and every 10 minutes. Only the merge holds the repo's turn, never the network.
 * It merges rather than rebases, because paired devices already have these commits. Project memory stays on its
 * device. Bundles pass through a private folder in DATA_DIR, made and removed within the repo's turn.
 */

const INTERVAL_MS = 10 * 60_000;
/** How soon after a paired device's change this one pulls it, so a burst of changes is one pull. */
const PEER_DELAY_MS = 2000;
const REMOTE_DELAY_MS = 5000;
const MAX_BUNDLE_BYTES = 50 * 1024 * 1024;
/** How long this device waits for the other to merge before it merges itself. */
const WAIT_MS = 30 * 60_000;
const STATE_KEY = "memorySync";
/** Bundles on their way in or out, in a folder only this user can read (0700). */
export const SYNC_TMP = join(DATA_DIR, "tmp", "memory-sync");

export const BUNDLE_PATH = "/api/memory/sync/you.bundle";

interface PeerState {
  lastSyncAt: number | null;
  ok: boolean | null;
  error: string | null;
  waitingSince?: number | null;
}

interface SyncState {
  peers: Record<string, PeerState>;
  remote: { lastPushAt: number | null; lastPullAt: number | null; error: string | null };
}

function readState(): SyncState {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(STATE_KEY) as Row | undefined;
  const stored = parseJson<Partial<SyncState>>(row?.value, {});
  return { peers: stored.peers ?? {}, remote: { lastPushAt: null, lastPullAt: null, error: null, ...stored.remote } };
}

function saveState(update: (state: SyncState) => void): void {
  const state = readState();
  update(state);
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(STATE_KEY, JSON.stringify(state));
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** A private folder for one bundle, inside the repo's turn; removed by `done`. */
function privateFolder(): { folder: string; done: () => void } {
  mkdirSync(SYNC_TMP, { recursive: true, mode: 0o700 });
  const folder = mkdtempSync(join(SYNC_TMP, "b-"));
  return { folder, done: () => rmSync(folder, { recursive: true, force: true }) };
}

/** The "you" repo as a git bundle (its main branch), for a paired device to fetch. */
export async function createBundle(): Promise<Buffer> {
  await ensureRepo(YOU);
  return withRepo(YOU, async () => {
    const { folder, done } = privateFolder();
    try {
      const file = join(folder, "you.bundle");
      await git(repoDir(YOU), ["bundle", "create", "--quiet", file, "main"]);
      return readFileSync(file);
    } finally {
      done();
    }
  });
}

/** One line per change a sync brings in, for its commit's body: shortened, secrets hidden. */
const incomingLines = (subjects: string) =>
  subjects
    .split("\n")
    .filter(Boolean)
    .map((subject) => `- ${subjectText(hideSecrets(subject), 100)}`)
    .join("\n");

/**
 * Brings a paired device's bundle into the "you" repo: fetched into `ref`, then a fast-forward, or a merge when
 * `merge` (else it waits for that device to merge ours: `diverged`). Returns whether this repo changed.
 */
export async function mergeBundle(bundle: Buffer, ref: string, from: string, { merge = true } = {}): Promise<{ changed: boolean; diverged: boolean }> {
  if (!/^refs\/peers\/[\w-]+$/.test(ref)) throw new Error("Bad ref for a memory bundle.");
  return withRepo(YOU, async () => {
    await initRepo(YOU);
    const outside = await commitOutsideEdits(YOU);
    const dir = repoDir(YOU);
    const { folder, done } = privateFolder();
    try {
      const file = join(folder, "peer.bundle");
      writeFileSync(file, bundle, { mode: 0o600 });
      await git(dir, ["fetch", "--quiet", "--no-tags", file, `+refs/heads/main:${ref}`]);
    } finally {
      done();
    }
    const incoming = incomingLines(await git(dir, ["log", "--no-merges", "--format=%s", "-n", "20", `HEAD..${ref}`]).catch(() => ""));
    const { changed, diverged } = await mergeRef(YOU, ref, { subject: `Sync: synced with ${subjectText(from, 60)}`, body: incoming, actor: "Sync", kind: "sync" }, { fastForwardOnly: !merge });
    if (changed || outside) afterChange(YOU, await head(YOU));
    return { changed, diverged };
  });
}

/** Reads a response body, giving up (and closing it) past `max` bytes. */
export async function readCapped(res: Response, max: number): Promise<Buffer> {
  const declared = Number(res.headers.get("content-length"));
  if (declared > max) {
    await res.body?.cancel().catch(() => {});
    throw new Error("too big");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = res.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      throw new Error("too big");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Whether this device merges a paired device's changes, or waits for that device to merge ours: the one with the
 * smaller id merges, unless the other can't reach it, or it hasn't for 30 minutes (it's off, or an old TOT).
 */
export function mergesWith(self: string, peer: string, peerCanReachUs: boolean, waitingSince: number | null | undefined, now = Date.now()): boolean {
  return self < peer || !peerCanReachUs || (waitingSince != null && now - waitingSince >= WAIT_MS);
}

/** Fetches a paired device's bundle and merges it. */
async function pullPeer(peer: Peer, waitingSince: number | null | undefined): Promise<{ changed: boolean; diverged: boolean }> {
  const token = peers.tokenFor(peer.id);
  if (!token || !peer.address) throw new Error(`${peer.name} can't be reached from this device.`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(`${peer.address}${BUNDLE_PATH}`, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
    if (res.status === 404) throw new Error(`${peer.name} runs a TOT without memory sync. Update it there.`);
    if (!res.ok) throw new Error(`${peer.name} didn't share its memory (${res.status}).`);
    const bundle = await readCapped(res, MAX_BUNDLE_BYTES).catch((err: unknown) => {
      throw new Error(message(err) === "too big" ? `${peer.name}'s memory is too big to sync.` : message(err));
    });
    const merge = mergesWith(deviceId(), peer.id, Boolean(relay.device(peer.id)?.canReachUs), waitingSince);
    return await mergeBundle(bundle, `refs/peers/${peer.id}`, peer.name, { merge });
  } finally {
    clearTimeout(timer);
  }
}

const busy = new Set<string>();
const again = new Set<string>();
const timers = new Map<string, NodeJS.Timeout>();

/** Pulls one paired device now (or right after the pull already running). */
async function syncPeer(id: string): Promise<void> {
  const peer = peers.get(id);
  if (!peer) return;
  if (busy.has(id)) {
    again.add(id);
    return;
  }
  busy.add(id);
  try {
    const { diverged } = await pullPeer(peer, readState().peers[id]?.waitingSince);
    // Both changed and the other device merges: wait for it (counted from the first time).
    saveState(
      (state) =>
        (state.peers[id] = { lastSyncAt: Date.now(), ok: true, error: null, waitingSince: diverged ? (state.peers[id]?.waitingSince ?? Date.now()) : null }),
    );
  } catch (err) {
    const error = err instanceof GitError ? "Couldn't merge its memory." : message(err);
    console.warn(`[tot] memory sync with ${peer.name} failed: ${message(err)}`);
    saveState((state) => (state.peers[id] = { ...state.peers[id], lastSyncAt: state.peers[id]?.lastSyncAt ?? null, ok: false, error }));
  } finally {
    busy.delete(id);
  }
  if (again.delete(id)) await syncPeer(id);
}

function soon(key: string, ms: number, run: () => Promise<void>) {
  clearTimeout(timers.get(key));
  const timer = setTimeout(() => {
    timers.delete(key);
    void run();
  }, ms);
  timer.unref();
  timers.set(key, timer);
}

// --- The optional backup remote ---------------------------------------------------------------------------------

/**
 * A remote URL memory can use: SSH (git@host:path, ssh://), HTTPS, file:// or an absolute path. Passwords and
 * tokens never go in it (they'd sit in settings): use SSH keys or git's credential helper instead.
 */
export function remoteUrlProblem(url: string): string | null {
  const value = url.trim();
  if (!value) return null;
  if (/\s/.test(value)) return "A git remote URL has no spaces.";
  if (/^[\w.-]+@[\w.-]+:[^\s]+$/.test(value) || value.startsWith("/")) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "That isn't a git remote URL. Use one like git@github.com:you/memory.git.";
  }
  if (!["ssh:", "https:", "file:"].includes(parsed.protocol)) return "Use an SSH or HTTPS URL for the backup remote.";
  if (parsed.password || (parsed.protocol === "https:" && parsed.username)) {
    return "Don't put a password or token in the URL. Use an SSH URL, or let git's credential helper sign in.";
  }
  return null;
}

let remoteBusy: Promise<void> | null = null;

/** Network calls to the backup remote: the user's SSH keys and credential helper, a minute at most. */
const REMOTE = { remote: true, timeoutMs: 60_000 } as const;
const PUSH_TRIES = 3;

/** A push refused because the remote moved on meanwhile (not one the remote itself declined). */
const pushRaced = (err: unknown) => err instanceof GitError && /\[rejected\]|non-fast-forward|fetch first|stale info/i.test(err.message);

/**
 * Fetch and merge from the backup remote, then push; a no-op while it's off. The fetch and the push run outside
 * the repo's turn, so a slow or unreachable remote never holds up a write; only the merge takes the turn. A push
 * the remote refused because it moved on meanwhile fetches and merges again.
 */
export async function syncRemote(): Promise<void> {
  const { remote } = settings.get().memory;
  if (!remote.enabled || !remote.url.trim()) return;
  if (remoteBusy) return remoteBusy;
  remoteBusy = (async () => {
    try {
      const url = remote.url.trim();
      const problem = remoteUrlProblem(url);
      if (problem) throw new Error(problem);
      await ensureRepo(YOU);
      const dir = repoDir(YOU);
      for (let attempt = 1; ; attempt++) {
        const heads = (await git(dir, ["ls-remote", "--heads", "--", url, "main"], REMOTE)).trim();
        if (heads) await git(dir, ["fetch", "--quiet", "--no-tags", "--", url, "+refs/heads/main:refs/remotes/origin/main"], REMOTE);
        const sha = await withRepo(YOU, async () => {
          const before = await head(YOU);
          try {
            await initRepo(YOU);
            await commitOutsideEdits(YOU);
            if (heads) {
              await mergeRef(YOU, "refs/remotes/origin/main", { subject: "Backup: synced with the backup remote", actor: "Backup", kind: "backup" });
              saveState((state) => (state.remote.lastPullAt = Date.now()));
            }
          } finally {
            // Whatever happens next (a push that fails), the index and the screens follow a head that moved.
            const after = await head(YOU);
            if (after !== before) afterChange(YOU, after);
          }
          return (await head(YOU))!;
        });
        try {
          await git(dir, ["push", "--quiet", "--", url, `${sha}:refs/heads/main`], REMOTE);
          break;
        } catch (err) {
          if (attempt >= PUSH_TRIES || !pushRaced(err)) throw err;
        }
      }
      saveState((state) => {
        state.remote.lastPushAt = Date.now();
        state.remote.error = null;
      });
    } catch (err) {
      console.warn(`[tot] memory backup failed: ${message(err)}`);
      saveState((state) => (state.remote.error = err instanceof GitError ? `Couldn't reach the backup remote: ${err.message.replace(/^git \w+ failed: /, "")}` : message(err)));
    } finally {
      remoteBusy = null;
    }
  })();
  return remoteBusy;
}

// --- Status and scheduling --------------------------------------------------------------------------------------

export function syncStatus(): MemorySyncStatus {
  const state = readState();
  const { remote } = settings.get().memory;
  const list: MemoryPeerSync[] = peers.list().map((peer) => ({
    deviceId: peer.id,
    name: peer.name,
    online: relay.online(peer.id),
    lastSyncAt: state.peers[peer.id]?.lastSyncAt ?? null,
    ok: state.peers[peer.id]?.ok ?? null,
    error: state.peers[peer.id]?.error ?? null,
    waitingSince: state.peers[peer.id]?.waitingSince ?? null,
  }));
  const backup: MemoryRemoteStatus = { url: remote.url, enabled: remote.enabled, ...state.remote };
  return { peers: list, remote: backup };
}

/** Syncs with every online paired device, then the backup remote. */
export async function syncNow(): Promise<MemorySyncStatus> {
  await Promise.all(peers.list().filter((peer) => relay.online(peer.id)).map((peer) => syncPeer(peer.id)));
  await syncRemote();
  return syncStatus();
}

let interval: NodeJS.Timeout | null = null;
let unsubscribe: (() => void) | null = null;
let listening = false;

export const memorySync = {
  start(): void {
    if (interval) return;
    interval = setInterval(() => void syncNow(), INTERVAL_MS);
    interval.unref();
    // Changes here go to the backup remote soon after; a paired device coming online is pulled.
    unsubscribe = appEvents.subscribe((event) => {
      if (event.type === "memory" && event.repo === YOU) soon("remote", REMOTE_DELAY_MS, syncRemote);
      if (event.type === "device" && !event.device.self && event.device.online) soon(`peer:${event.device.id}`, PEER_DELAY_MS, () => syncPeer(event.device.id));
    });
    // A paired device's memory changed: pull it.
    if (!listening) {
      listening = true;
      relay.onEvent((deviceId, event) => {
        if (interval && event.type === "memory" && event.repo === YOU) soon(`peer:${deviceId}`, PEER_DELAY_MS, () => syncPeer(deviceId));
      });
    }
    soon("all", 5000, async () => void (await syncNow()));
  },

  stop(): void {
    if (interval) clearInterval(interval);
    interval = null;
    unsubscribe?.();
    unsubscribe = null;
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  },

  /** The settings changed: a newly set remote is tried soon. */
  settingsChanged(): void {
    if (interval) soon("remote", 500, syncRemote);
  },
};
