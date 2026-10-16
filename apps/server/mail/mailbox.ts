import { createHash, randomUUID } from "node:crypto";
import type { MailAddress, MailboxConnectRequest, Persona } from "@tot/shared/types";
import { HttpError } from "../agent/orchestrator.ts";
import { appEvents } from "../app-events.ts";
import { getSecret, setSecret } from "../config.ts";
import { mail, toSummary, type MailFolder, type StoredMail } from "../data/mail.ts";
import { EMPTY_MAILBOX, personas, type MailSync } from "../data/personas.ts";
import { parseMail, type ParsedEmail } from "./parse.ts";
import { mailSettings, trustedAuthserv, type MailSettings } from "./servers.ts";
import { composeMail, imapTransport, MailLoginError, type MailAccount, type MailConnection, type MailTransport } from "./transport.ts";

/**
 * Personas' mailboxes. Connecting signs in over IMAP and SMTP with an app password (kept in
 * secrets.json, never sent back), then stores the most recent mail from INBOX and Sent. After
 * that, new mail arrives over IMAP IDLE, with a poll every couple of minutes as a safety net;
 * dropped connections come back with backoff. Agents read, search, wait for and send mail
 * through here; new INBOX mail is handed to listeners (emailed tasks, see tasks.ts).
 */

const BACKFILL = 50;
/** Stored emails per persona; older ones are forgotten. */
const KEEP = 2000;
const POLL_MS = 2 * 60_000;
/** While an agent waits for an email, check this often too (IDLE usually beats it). */
const WAITING_POLL_MS = 15_000;
/** Mail stored this recently counts for a wait: the agent often sets off the email just before waiting. */
const WAIT_LOOKBACK_MS = 60_000;
const NEWS_DELAY_MS = 400;
const RETRY_MS = [2_000, 5_000, 15_000, 30_000, 60_000, 120_000, 300_000];
/** Read state is mirrored for this many of the newest INBOX emails. */
const MIRROR_SEEN = 200;

interface Live {
  connection: MailConnection;
  poll: NodeJS.Timeout;
  /** Syncs run one at a time. */
  queue: Promise<unknown>;
}

interface Waiter {
  personaId: string;
  matches: (mail: StoredMail) => boolean;
  resolve: (mail: StoredMail | null) => void;
}

const live = new Map<string, Live>();
const retries = new Map<string, { timer: NodeJS.Timeout; attempt: number }>();
const waiters = new Set<Waiter>();
const incoming = new Set<(persona: Persona, mail: StoredMail) => void>();
let transport: MailTransport = imapTransport;

const secretName = (personaId: string) => `mailPassword:${personaId}` as const;
const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
const changed = (personaId: string) => appEvents.personaChanged(personaId);

/** What went wrong signing in, in words the user can act on. Never includes the password. */
function loginProblem(err: unknown, settings: Pick<MailSettings, "provider" | "imap" | "smtp" | "username">): string {
  if (!(err instanceof MailLoginError)) return `Couldn't sign in to the mailbox: ${errorText(err)}`;
  const server = err.service === "IMAP" ? settings.imap : settings.smtp;
  const detail = err.message ? ` (${err.message})` : "";
  if (err.kind === "auth") {
    if (settings.provider === "Gmail") {
      return "Gmail didn't accept the password. Gmail needs an app password: turn on 2-Step Verification for the account, then create one at myaccount.google.com/apppasswords and paste it here (not the account's normal password).";
    }
    return `${settings.provider} didn't accept the ${err.service} login for ${settings.username}. Most providers need an app password for IMAP and SMTP, not the account's normal one.${detail}`;
  }
  if (err.kind === "unreachable") return `Couldn't reach the ${err.service} server ${server.host}:${server.port}${detail}.`;
  return `Signing in to the ${err.service} server ${server.host} failed${detail}.`;
}

/** The saved account, when the mailbox is set up and its password is still there. */
function savedAccount(persona: Persona): MailAccount | null {
  const box = personas.mailbox(persona.id);
  const password = getSecret(secretName(persona.id));
  if (!password || !box.imap || !box.smtp) return null;
  return { email: persona.email, username: box.username ?? persona.email, password, imap: box.imap, smtp: box.smtp };
}

/** Emails in one conversation share a thread: the one it replies to when TOT has it, else the server's, else the References root. */
function threadIdFor(personaId: string, parsed: ParsedEmail, serverThreadId?: string): string {
  const chain = [parsed.inReplyTo, ...[...parsed.references].reverse()].filter((id): id is string => Boolean(id));
  const known = mail.threadOf(personaId, chain);
  if (known) return known;
  const key = serverThreadId
    ? `server:${serverThreadId}`
    : `root:${parsed.references[0] ?? parsed.inReplyTo ?? parsed.messageId ?? randomUUID()}`;
  return `th_${createHash("sha256").update(key).digest("hex").slice(0, 16)}`;
}

/** Stores one raw email; null when TOT already has it. */
async function store(
  persona: Persona,
  raw: { folder: MailFolder; validity: string | null; uid: number | null; source: Buffer; seen: boolean; threadId?: string; receivedAt?: number },
  authserv: RegExp | null,
): Promise<StoredMail | null> {
  if (raw.uid !== null && raw.validity && mail.byUid(persona.id, raw.folder, raw.validity, raw.uid)) return null;
  const parsed = await parseMail(raw.source, { authserv });
  const known = parsed.messageId ? mail.byMessageId(persona.id, parsed.messageId) : null;
  if (known) {
    // TOT's own copy of mail it sent, now seen in the server's Sent folder.
    if (known.uid === null && raw.uid !== null && raw.validity) mail.attachUid(known.id, raw.folder, raw.validity, raw.uid);
    return null;
  }
  const outgoing = parsed.from.address === persona.email.toLowerCase();
  return mail.insert({
    personaId: persona.id,
    folder: raw.folder,
    uid: raw.uid,
    uidValidity: raw.validity,
    messageId: parsed.messageId,
    inReplyTo: parsed.inReplyTo,
    references: parsed.references,
    threadId: threadIdFor(persona.id, parsed, raw.threadId),
    from: parsed.from,
    to: parsed.to,
    cc: parsed.cc,
    subject: parsed.subject,
    text: parsed.text,
    links: parsed.links,
    codes: parsed.codes,
    attachments: parsed.attachments,
    date: raw.receivedAt ?? parsed.date ?? Date.now(),
    unread: !raw.seen && !outgoing,
    outgoing,
    authenticated: parsed.authenticated,
    automated: parsed.automated,
  });
}

/** Tells the UI, and for new mail to the persona: agents waiting for it, and emailed tasks. */
function announce(persona: Persona, stored: StoredMail): void {
  appEvents.publish({ type: "mail", personaId: persona.id, mail: toSummary(stored) });
  if (stored.outgoing || stored.folder !== "inbox") return;
  for (const waiter of waiters) if (waiter.personaId === persona.id && waiter.matches(stored)) waiter.resolve(stored);
  for (const listener of incoming) listener(persona, stored);
}

/** Brings stored mail up to date: new mail in INBOX and Sent (the newest few after a reset), and read state. */
async function syncNow(personaId: string, connection: MailConnection): Promise<void> {
  const persona = personas.get(personaId);
  if (!persona) return;
  const authserv = trustedAuthserv(personas.mailbox(personaId).imap?.host ?? "");
  const state: MailSync = personas.sync(personaId) ?? { address: persona.email };
  // The connection was replaced or dropped mid-sync: what it read decides nothing more.
  const current = () => live.get(personaId)?.connection === connection;
  // The user disconnected mid-sync: leave the mailbox as they left it.
  const disconnected = () => !getSecret(secretName(personaId));
  const fresh: StoredMail[] = [];
  for (const folder of ["inbox", "sent"] as const) {
    const cursor = state[folder];
    let read = await connection.read(folder, cursor ? { fromUid: cursor.next } : { newest: BACKFILL });
    // Backfilled history is only stored: it's neither "new mail" nor a task.
    let backfill = !cursor;
    if (read && cursor && read.validity !== cursor.validity) {
      read = await connection.read(folder, { newest: BACKFILL });
      backfill = true;
    }
    if (!current()) return;
    if (!read) continue;
    for (const fetched of read.mail) {
      const stored = await store(persona, { folder, validity: read.validity, ...fetched }, authserv);
      if (stored && !backfill) fresh.push(stored);
    }
    if (disconnected()) return;
    state[folder] = { validity: read.validity, next: read.uidNext };
    personas.setSync(personaId, state);
  }
  // Mirror reads done elsewhere (e.g. in Gmail itself).
  if (state.inbox && current()) {
    const seen = await connection.seen("inbox", mail.newestUids(personaId, "inbox", state.inbox.validity, MIRROR_SEEN));
    mail.mirrorSeen(personaId, "inbox", state.inbox.validity, seen);
  }
  if (disconnected()) return;
  mail.prune(personaId, KEEP);
  if (current()) personas.setMailbox(personaId, { state: "connected", error: null, checkedAt: Date.now() });
  changed(personaId);
  // Announced even if the connection dropped meanwhile: stored mail isn't "new" a second time.
  for (const stored of fresh) announce(persona, stored);
}

function sync(personaId: string): Promise<void> {
  const box = live.get(personaId);
  if (!box) return Promise.reject(new Error("The mailbox isn't connected right now."));
  const run = box.queue.then(() => syncNow(personaId, box.connection));
  box.queue = run.catch(() => {});
  return run;
}

function syncFailed(personaId: string, err: unknown): void {
  // A sync cut short by a disconnect or a dropped connection isn't news; reconnecting reports its own problems.
  if (!live.has(personaId)) return;
  console.warn("[tot] mail sync failed:", errorText(err));
  personas.setMailbox(personaId, { error: `Couldn't check for new mail: ${errorText(err)}` });
  changed(personaId);
}

function attach(personaId: string, connection: MailConnection): void {
  let pending: NodeJS.Timeout | null = null;
  connection.on("news", () => {
    pending ??= setTimeout(() => {
      pending = null;
      sync(personaId).catch((err) => syncFailed(personaId, err));
    }, NEWS_DELAY_MS);
  });
  connection.on("close", () => {
    if (live.get(personaId)?.connection !== connection) return;
    detach(personaId);
    personas.setMailbox(personaId, { state: "connecting" });
    changed(personaId);
    scheduleRetry(personaId);
  });
  const poll = setInterval(() => sync(personaId).catch((err) => syncFailed(personaId, err)), POLL_MS);
  poll.unref();
  live.set(personaId, { connection, poll, queue: Promise.resolve() });
}

function detach(personaId: string): Live | undefined {
  const box = live.get(personaId);
  if (box) clearInterval(box.poll);
  live.delete(personaId);
  return box;
}

function scheduleRetry(personaId: string): void {
  const previous = retries.get(personaId);
  if (previous) clearTimeout(previous.timer);
  const attempt = previous?.attempt ?? 0;
  const timer = setTimeout(() => void reopen(personaId), RETRY_MS[Math.min(attempt, RETRY_MS.length - 1)]);
  timer.unref();
  retries.set(personaId, { timer, attempt: attempt + 1 });
}

/** Reconnects with the saved password (on startup, or after the connection dropped). */
async function reopen(personaId: string): Promise<void> {
  const persona = personas.get(personaId);
  const account = persona && savedAccount(persona);
  if (!persona || !account || live.has(personaId)) return;
  let connection: MailConnection;
  try {
    connection = await transport.connect(account);
  } catch (err) {
    const provider = personas.mailbox(personaId).provider ?? account.imap.host;
    personas.setMailbox(personaId, { state: "error", error: loginProblem(err, { ...account, provider }) });
    changed(personaId);
    // A rejected password won't start working by itself, and retrying could get the account locked.
    if (!(err instanceof MailLoginError && err.kind === "auth")) scheduleRetry(personaId);
    return;
  }
  // Disconnected (or connected again by hand) while this attempt was in flight.
  if (!getSecret(secretName(personaId)) || live.has(personaId)) {
    await connection.close().catch(() => {});
    return;
  }
  retries.delete(personaId);
  attach(personaId, connection);
  await sync(personaId).catch((err) => syncFailed(personaId, err));
}

async function stop(personaId: string): Promise<void> {
  const retry = retries.get(personaId);
  if (retry) clearTimeout(retry.timer);
  retries.delete(personaId);
  await detach(personaId)?.connection.close().catch(() => {});
}

const contains = (text: string, part: string | undefined) => !part?.trim() || text.toLowerCase().includes(part.trim().toLowerCase());

export interface Draft {
  to: MailAddress[];
  cc?: MailAddress[];
  subject: string;
  text: string;
  inReplyTo?: string | null;
  references?: string[];
}

/** A reply in the email's thread ("Re: …", In-Reply-To and References set): to its sender, or everyone on it. */
export function replyDraft(original: StoredMail, selfAddress: string, text: string, replyAll = false): Draft {
  const self = selfAddress.toLowerCase();
  const to = original.outgoing ? original.to : [original.from];
  const cc: MailAddress[] = [];
  if (replyAll) {
    for (const a of [...original.to, ...original.cc]) {
      if (a.address !== self && ![...to, ...cc].some((b) => b.address === a.address)) cc.push(a);
    }
  }
  return {
    to,
    cc,
    subject: /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`,
    text,
    inReplyTo: original.messageId,
    references: [...new Set([...original.references, original.messageId].filter((id): id is string => Boolean(id)))].slice(-20),
  };
}

export const mailboxes = {
  /** Signs in over IMAP and SMTP; only then saves the password and stores recent mail. 400 with the reason otherwise. */
  async connect(personaId: string, request: Partial<MailboxConnectRequest>): Promise<Persona> {
    const persona = personas.get(personaId);
    if (!persona) throw new HttpError(404, "Persona not found.");
    const settings = mailSettings(persona.email, request);
    if (typeof settings === "string") throw new HttpError(400, settings);
    let connection: MailConnection;
    try {
      connection = await transport.connect({ email: persona.email, ...settings });
    } catch (err) {
      throw new HttpError(400, loginProblem(err, settings));
    }
    await stop(personaId);
    // Mail stored for another address doesn't belong to this mailbox.
    if (personas.sync(personaId)?.address !== persona.email) {
      mail.clear(personaId);
      personas.setSync(personaId, { address: persona.email });
    }
    setSecret(secretName(personaId), settings.password);
    personas.setMailbox(personaId, {
      state: "connected",
      error: null,
      provider: settings.provider,
      imap: settings.imap,
      smtp: settings.smtp,
      username: settings.username === persona.email ? null : settings.username,
    });
    attach(personaId, connection);
    await sync(personaId).catch((err) => syncFailed(personaId, err));
    changed(personaId);
    return personas.get(personaId)!;
  },

  /** Disconnects and forgets the password. Stored mail stays; connecting again starts with fresh history. */
  async disconnect(personaId: string): Promise<void> {
    await stop(personaId);
    setSecret(secretName(personaId), "");
    personas.setMailbox(personaId, { ...EMPTY_MAILBOX });
    const sync = personas.sync(personaId);
    if (sync) personas.setSync(personaId, { address: sync.address });
    for (const waiter of waiters) if (waiter.personaId === personaId) waiter.resolve(null);
    changed(personaId);
  },

  /** On TOT startup: reconnect every mailbox that has a saved password. */
  resume(): void {
    for (const persona of personas.list()) {
      if (persona.mailbox.state === "not-connected") continue;
      if (!savedAccount(persona)) {
        personas.setMailbox(persona.id, { state: "error", error: "The mailbox password is missing; connect the mailbox again." });
        continue;
      }
      personas.setMailbox(persona.id, { state: "connecting", error: null });
      void reopen(persona.id);
    }
  },

  /** On TOT shutdown. */
  async stopAll(): Promise<void> {
    await Promise.allSettled([...new Set([...live.keys(), ...retries.keys()])].map(stop));
  },

  /** Check for new mail now (reconnecting first if the connection is down). */
  async refresh(personaId: string): Promise<void> {
    const persona = personas.get(personaId);
    if (!persona || !savedAccount(persona)) throw new HttpError(400, "Connect the mailbox first.");
    if (!live.has(personaId)) {
      await reopen(personaId);
      if (!live.has(personaId)) throw new HttpError(400, personas.mailbox(personaId).error ?? "Couldn't reach the mailbox.");
      return;
    }
    await sync(personaId).catch((err) => {
      syncFailed(personaId, err);
      throw new HttpError(400, `Couldn't check for new mail: ${errorText(err)}`);
    });
  },

  connected(personaId: string): boolean {
    return live.has(personaId);
  },

  /** Marks an email read in TOT, and \Seen on the server when possible. */
  markRead(personaId: string, stored: StoredMail): void {
    if (!mail.setUnread(stored.id, false)) return;
    changed(personaId);
    const box = live.get(personaId);
    const cursor = personas.sync(personaId)?.[stored.folder];
    if (box && stored.uid !== null && stored.uidValidity === cursor?.validity) {
      box.connection.markSeen(stored.folder, stored.uid).catch((err) => console.warn("[tot] couldn't mark mail read on the server:", errorText(err)));
    }
  },

  /** Sends as the persona and stores the sent copy. */
  async send(personaId: string, draft: Draft): Promise<StoredMail> {
    const persona = personas.get(personaId);
    const box = live.get(personaId);
    if (!persona || !box) throw new Error(`${persona?.name ?? "The persona"}'s mailbox isn't connected right now; try again in a moment.`);
    const { raw, messageId } = await composeMail({
      from: { name: persona.name, address: persona.email },
      to: draft.to,
      cc: draft.cc ?? [],
      subject: draft.subject,
      text: draft.text,
      inReplyTo: draft.inReplyTo,
      references: draft.references,
    });
    await box.connection.send({ from: persona.email, to: [...draft.to, ...(draft.cc ?? [])].map((a) => a.address) }, raw);
    const stored = await store(persona, { folder: "sent", validity: null, uid: null, source: raw, seen: true }, null);
    if (stored) announce(persona, stored);
    return stored ?? mail.byMessageId(personaId, messageId)!;
  },

  /** Replies in the email's thread, as replyDraft builds it. */
  reply(personaId: string, original: StoredMail, text: string, opts: { replyAll?: boolean } = {}): Promise<StoredMail> {
    return mailboxes.send(personaId, replyDraft(original, personas.get(personaId)?.email ?? "", text, opts.replyAll));
  },

  /** The first new email to the persona that matches (sender and subject contain…), or null at the timeout. */
  async waitFor(
    personaId: string,
    filter: { from?: string; subject?: string },
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<StoredMail | null> {
    const matches = (m: StoredMail) => !m.outgoing && contains(`${m.from.name ?? ""} <${m.from.address}>`, filter.from) && contains(m.subject, filter.subject);
    const recent = mail.list(personaId, { incomingOnly: true, storedSince: Date.now() - WAIT_LOOKBACK_MS, limit: 20 }).find(matches);
    if (recent) return mail.get(personaId, recent.id);
    if (signal?.aborted) return null;
    return new Promise((resolve) => {
      const finish = (found: StoredMail | null) => {
        clearTimeout(timer);
        clearInterval(poll);
        waiters.delete(waiter);
        signal?.removeEventListener("abort", abort);
        resolve(found ? mail.get(personaId, found.id) : null);
      };
      const waiter: Waiter = { personaId, matches, resolve: finish };
      const abort = () => finish(null);
      const check = () => void sync(personaId).catch(() => {});
      const timer = setTimeout(abort, timeoutMs);
      const poll = setInterval(check, WAITING_POLL_MS);
      waiters.add(waiter);
      signal?.addEventListener("abort", abort, { once: true });
      check();
    });
  },

  /** New mail to a persona (not backfilled history), e.g. for emailed tasks. Returns an unsubscribe. */
  onIncoming(listener: (persona: Persona, mail: StoredMail) => void): () => void {
    incoming.add(listener);
    return () => incoming.delete(listener);
  },

  /** Tests: a fake IMAP/SMTP layer. */
  useTransport(fake: MailTransport): void {
    transport = fake;
  },
};
