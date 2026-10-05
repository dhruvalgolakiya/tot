import { randomBytes } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MemoryPeerSync, MemoryRemoteStatus, MemorySyncStatus } from "../../shared/types.ts";
import { appEvents } from "../app-events.ts";
import { db, parseJson, type Row } from "../db.ts";
import { settings } from "../data/settings.ts";
import { deviceId } from "../devices/identity.ts";
import { peers, type Peer } from "../devices/peers.ts";
import { relay } from "../devices/relay.ts";
import { afterChange, ensureRepo } from "./memory.ts";
import { commitOutsideEdits, git, GitError, head, initRepo, mergeRef, repoDir, withRepo, YOU } from "./repo.ts";

/**
 * Memory that follows you (roadmap module 10). The "you" repo syncs with paired devices, no GitHub needed:
 *  - each device serves its repo as a git bundle at GET /api/memory/sync/you.bundle, to paired devices only;
 *  - every 10 minutes, soon after a paired device says its memory changed, and when one comes online, this device
 *    fetches that device's bundle into refs/peers/<deviceId> and brings it in (union for markdown; any other file
 *    that conflicts keeps this device's version). Both sides pull, so they converge. Of each pair only one device
 *    merges (the one with the smaller id, or the one the other can't reach); the other fast-forwards to its
 *    merge. Two devices merging each other at once would otherwise make different merges and go round again.
 * Optionally the repo is also backed up to a private git remote the user set up (`memory.remote`): fetch and
 * merge, then push, soon after each change and every 10 minutes. It merges rather than rebases, because paired
 * devices already have these commits. Project memory stays on its device.
 */

const INTERVAL_MS = 10 * 60_000;
/** How soon after a paired device's change this one pulls it, so a burst of changes is one pull. */
const PEER_DELAY_MS = 2000;
const REMOTE_DELAY_MS = 5000;
const MAX_BUNDLE_BYTES = 50 * 1024 * 1024;
const STATE_KEY = "memorySync";

export const BUNDLE_PATH = "/api/memory/sync/you.bundle";

interface SyncState {
  peers: Record<string, { lastSyncAt: number | null; ok: boolean | null; error: string | null }>;
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

/** The "you" repo as a git bundle (its main branch), for a paired device to fetch. */
export async function createBundle(): Promise<Buffer> {
  await ensureRepo(YOU);
  return withRepo(YOU, async () => {
    const file = join(tmpdir(), `tot-memory-${randomBytes(6).toString("hex")}.bundle`);
    try {
      await git(repoDir(YOU), ["bundle", "create", "--quiet", file, "main"]);
      return readFileSync(file);
    } finally {
      rmSync(file, { force: true });
    }
  });
}

/**
 * Brings a paired device's bundle into the "you" repo: fetched into `ref`, then a fast-forward, or a merge when
 * `merge` (else it waits for that device to merge ours). Returns whether this repo changed.
 */
export async function mergeBundle(bundle: Buffer, ref: string, from: string, { merge = true } = {}): Promise<boolean> {
  if (!/^refs\/peers\/[\w-]+$/.test(ref)) throw new Error("Bad ref for a memory bundle.");
  const file = join(tmpdir(), `tot-memory-${randomBytes(6).toString("hex")}.bundle`);
  writeFileSync(file, bundle);
  try {
    return await withRepo(YOU, async () => {
      await initRepo(YOU);
      const outside = await commitOutsideEdits(YOU);
      const dir = repoDir(YOU);
      await git(dir, ["fetch", "--quiet", "--no-tags", file, `+refs/heads/main:${ref}`]);
      const incoming = (await git(dir, ["log", "--no-merges", "--format=%s", "-n", "20", `HEAD..${ref}`]).catch(() => ""))
        .split("\n")
        .filter(Boolean)
        .map((subject) => `- ${subject}`)
        .join("\n");
      const { changed } = await mergeRef(YOU, ref, { subject: `Sync: merged from ${from}`, body: incoming, actor: "Sync", kind: "sync" }, { fastForwardOnly: !merge });
      if (changed || outside) afterChange(YOU, await head(YOU));
      return changed;
    });
  } finally {
    rmSync(file, { force: true });
  }
}

/** Fetches a paired device's bundle and merges it. Returns whether this repo changed. */
async function pullPeer(peer: Peer): Promise<boolean> {
  const token = peers.tokenFor(peer.id);
  if (!token || !peer.address) throw new Error(`${peer.name} can't be reached from this device.`);
  const res = await fetch(`${peer.address}${BUNDLE_PATH}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(60_000) });
  if (res.status === 404) throw new Error(`${peer.name} runs a TOT without memory sync. Update it there.`);
  if (!res.ok) throw new Error(`${peer.name} didn't share its memory (${res.status}).`);
  const bundle = Buffer.from(await res.arrayBuffer());
  if (bundle.length > MAX_BUNDLE_BYTES) throw new Error(`${peer.name}'s memory is too big to sync.`);
  // The other device merges ours when it can reach us and has the smaller id; we just catch up with it.
  const merge = deviceId() < peer.id || !relay.device(peer.id)?.canReachUs;
  return mergeBundle(bundle, `refs/peers/${peer.id}`, peer.name, { merge });
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
    await pullPeer(peer);
    saveState((state) => (state.peers[id] = { lastSyncAt: Date.now(), ok: true, error: null }));
  } catch (err) {
    const error = err instanceof GitError ? "Couldn't merge its memory." : message(err);
    console.warn(`[tot] memory sync with ${peer.name} failed: ${message(err)}`);
    saveState((state) => (state.peers[id] = { lastSyncAt: state.peers[id]?.lastSyncAt ?? null, ok: false, error }));
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

/** Fetch and merge from the backup remote, then push. A no-op while it's off. */
export async function syncRemote(): Promise<void> {
  const { remote } = settings.get().memory;
  if (!remote.enabled || !remote.url.trim()) return;
  if (remoteBusy) return remoteBusy;
  remoteBusy = (async () => {
    try {
      await ensureRepo(YOU);
      await withRepo(YOU, async () => {
        const dir = repoDir(YOU);
        const outside = await commitOutsideEdits(YOU);
        const url = remote.url.trim();
        const names = (await git(dir, ["remote"])).split("\n").map((name) => name.trim());
        await git(dir, names.includes("origin") ? ["remote", "set-url", "origin", url] : ["remote", "add", "origin", url]);
        let changed = Boolean(outside);
        for (let attempt = 0; attempt < 2; attempt++) {
          const heads = await git(dir, ["ls-remote", "--heads", "origin", "main"], { remote: true, timeoutMs: 60_000 });
          if (heads.trim()) {
            await git(dir, ["fetch", "--quiet", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"], { remote: true, timeoutMs: 60_000 });
            const merged = await mergeRef(YOU, "refs/remotes/origin/main", { subject: "Backup: merged from the remote", actor: "Backup", kind: "backup" });
            changed ||= merged.changed;
            saveState((state) => (state.remote.lastPullAt = Date.now()));
          }
          try {
            await git(dir, ["push", "--quiet", "origin", "HEAD:refs/heads/main"], { remote: true, timeoutMs: 60_000 });
            break;
          } catch (err) {
            // Someone pushed in between: pull again, once.
            if (attempt === 1) throw err;
          }
        }
        saveState((state) => {
          state.remote.lastPushAt = Date.now();
          state.remote.error = null;
        });
        if (changed) afterChange(YOU, await head(YOU));
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
