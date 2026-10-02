import { EventEmitter } from "node:events";
import { ImapFlow, type MailboxObject } from "imapflow";
import nodemailer, { type Transporter } from "nodemailer";
import type { MailAddress, MailServer } from "../../shared/types.ts";
import { VERSION } from "../config.ts";
import type { MailFolder } from "../data/mail.ts";

/**
 * The IMAP/SMTP layer under personas' mailboxes. The real one uses imapflow (reading, IDLE)
 * and nodemailer (sending); tests pass a fake MailTransport. Passwords never appear in errors.
 */

export interface MailAccount {
  email: string;
  username: string;
  password: string;
  imap: MailServer;
  smtp: MailServer;
}

/** One message as the server has it. */
export interface FetchedMail {
  uid: number;
  /** The raw message (RFC 822). */
  source: Buffer;
  seen: boolean;
  /** The server's thread id (Gmail's X-GM-THRID), when it has one. */
  threadId?: string;
  /** When the server received it (ms). */
  receivedAt?: number;
}

export interface FolderRead {
  /** UIDVALIDITY: when it changes, UIDs seen before mean nothing. */
  validity: string;
  /** The UID the next new message will get. */
  uidNext: number;
  /** Oldest first. */
  mail: FetchedMail[];
}

/** A signed-in mailbox: IMAP for reading (IDLE on INBOX), SMTP for sending. */
export interface MailConnection {
  /** The folder's newest `newest` messages, or those with UIDs from `fromUid` on; null when the folder doesn't exist. */
  read(folder: MailFolder, want: { newest: number } | { fromUid: number }): Promise<FolderRead | null>;
  /** Whether these messages are \Seen on the server, to mirror reads done elsewhere. */
  seen(folder: MailFolder, uids: number[]): Promise<Map<number, boolean>>;
  markSeen(folder: MailFolder, uid: number): Promise<void>;
  send(envelope: { from: string; to: string[] }, raw: Buffer): Promise<void>;
  /** "news": new mail may have arrived in INBOX; "close": the connection dropped. */
  on(event: "news" | "close", listener: () => void): void;
  close(): Promise<void>;
}

export interface MailTransport {
  /** Signs in over IMAP and checks SMTP; throws a MailLoginError saying what didn't work. */
  connect(account: MailAccount): Promise<MailConnection>;
}

export class MailLoginError extends Error {
  constructor(
    readonly service: "IMAP" | "SMTP",
    readonly kind: "auth" | "unreachable" | "other",
    message: string,
  ) {
    super(message);
  }
}

/** Big attachments aren't worth downloading whole: text comes first in a message. */
const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const UNREACHABLE = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ETIMEDOUT", "ECONNRESET", "EHOSTUNREACH", "ENETUNREACH", "ESOCKET", "ECONNECTION", "EDNS", "ETIMEOUT"]);

const scrub = (text: string, secret: string) => (secret ? text.split(secret).join("•••") : text);

function loginError(service: "IMAP" | "SMTP", err: unknown, password: string): MailLoginError {
  const e = (err ?? {}) as { authenticationFailed?: boolean; code?: string; responseCode?: number; response?: string; message?: string };
  const detail = scrub(String(e.response || e.message || err), password).replace(/\s+/g, " ").trim().slice(0, 240);
  if (e.authenticationFailed || e.code === "EAUTH" || e.responseCode === 535 || e.responseCode === 534) {
    return new MailLoginError(service, "auth", detail);
  }
  return new MailLoginError(service, UNREACHABLE.has(e.code ?? "") ? "unreachable" : "other", detail);
}

class ImapConnection implements MailConnection {
  private readonly events = new EventEmitter();
  private sentPath: string | null | undefined;
  private closing = false;

  constructor(
    private readonly client: ImapFlow,
    private readonly smtp: Transporter,
    private readonly password: string,
  ) {
    client.on("exists", (info: { path?: string }) => {
      if (info.path === "INBOX") this.events.emit("news");
    });
    client.on("close", () => {
      if (!this.closing) this.events.emit("close");
    });
    client.on("error", (err: Error) => console.warn("[tot] mailbox connection error:", scrub(err.message, password)));
  }

  private async path(folder: MailFolder): Promise<string | null> {
    if (folder === "inbox") return "INBOX";
    if (this.sentPath === undefined) {
      const list = await this.client.list();
      this.sentPath = list.find((box) => box.specialUse === "\\Sent")?.path ?? null;
    }
    return this.sentPath;
  }

  /** Runs with a folder selected, then selects INBOX again so IDLE keeps watching for new mail. */
  private async inFolder<T>(folder: MailFolder, run: (box: MailboxObject) => Promise<T>): Promise<T | null> {
    const path = await this.path(folder);
    if (!path) return null;
    const lock = await this.client.getMailboxLock(path);
    try {
      return await run(this.client.mailbox as MailboxObject);
    } finally {
      lock.release();
      if (path !== "INBOX") (await this.client.getMailboxLock("INBOX").catch(() => null))?.release();
    }
  }

  read(folder: MailFolder, want: { newest: number } | { fromUid: number }): Promise<FolderRead | null> {
    return this.inFolder(folder, async (box) => {
      const validity = String(box.uidValidity);
      const fromUid = "fromUid" in want ? want.fromUid : 0;
      if ("newest" in want && !box.exists) return { validity, uidNext: box.uidNext, mail: [] };
      // "n:*" by sequence for the newest; by UID otherwise (it always returns the last message, so filter).
      const range = "newest" in want ? `${Math.max(1, box.exists - want.newest + 1)}:*` : `${fromUid}:*`;
      const query = { uid: true, flags: true, threadId: true, internalDate: true, source: { maxLength: MAX_SOURCE_BYTES } };
      const mail: FetchedMail[] = [];
      for await (const message of this.client.fetch(range, query, { uid: "fromUid" in want })) {
        if (!message.source || message.uid < fromUid) continue;
        const received = message.internalDate ? new Date(message.internalDate).getTime() : NaN;
        mail.push({
          uid: message.uid,
          source: message.source,
          seen: message.flags?.has("\\Seen") ?? false,
          ...(message.threadId ? { threadId: message.threadId } : {}),
          ...(Number.isFinite(received) ? { receivedAt: received } : {}),
        });
      }
      mail.sort((a, b) => a.uid - b.uid);
      // UIDNEXT isn't pushed while a folder stays selected, so derive it from what arrived too.
      return { validity, uidNext: Math.max(box.uidNext, (mail.at(-1)?.uid ?? 0) + 1), mail };
    });
  }

  async seen(folder: MailFolder, uids: number[]): Promise<Map<number, boolean>> {
    if (!uids.length) return new Map();
    const found = await this.inFolder(folder, async () => {
      const map = new Map<number, boolean>();
      for await (const message of this.client.fetch(uids.join(","), { uid: true, flags: true }, { uid: true })) {
        map.set(message.uid, message.flags?.has("\\Seen") ?? false);
      }
      return map;
    });
    return found ?? new Map();
  }

  async markSeen(folder: MailFolder, uid: number): Promise<void> {
    await this.inFolder(folder, () => this.client.messageFlagsAdd(String(uid), ["\\Seen"], { uid: true }));
  }

  async send(envelope: { from: string; to: string[] }, raw: Buffer): Promise<void> {
    try {
      await this.smtp.sendMail({ envelope, raw });
    } catch (err) {
      throw new Error(`The mail server didn't send it: ${loginError("SMTP", err, this.password).message}`);
    }
  }

  on(event: "news" | "close", listener: () => void): void {
    this.events.on(event, listener);
  }

  async close(): Promise<void> {
    this.closing = true;
    this.events.removeAllListeners();
    this.smtp.close();
    await this.client.logout().catch(() => this.client.close());
  }
}

/** The real thing: imapflow for IMAP, nodemailer for SMTP. TLS always (implicit, or STARTTLS required). */
export const imapTransport: MailTransport = {
  async connect(account) {
    const { imap, smtp, username, password } = account;
    const client = new ImapFlow({
      host: imap.host,
      port: imap.port,
      secure: imap.port === 993,
      ...(imap.port === 993 ? {} : { doSTARTTLS: true }),
      auth: { user: username, pass: password },
      logger: false,
      clientInfo: { name: "TOT", version: VERSION },
      // Re-issue IDLE now and then: some servers silently drop long ones.
      maxIdleTime: 10 * 60_000,
      connectionTimeout: 30_000,
      greetingTimeout: 20_000,
    });
    client.on("error", () => {}); // connect() rejects with the same error
    try {
      await client.connect();
      await client.mailboxOpen("INBOX");
    } catch (err) {
      client.close();
      throw loginError("IMAP", err, password);
    }
    const sender = nodemailer.createTransport({
      host: smtp.host,
      port: smtp.port,
      secure: smtp.port === 465,
      requireTLS: smtp.port !== 465,
      auth: { user: username, pass: password },
      connectionTimeout: 30_000,
      greetingTimeout: 20_000,
      socketTimeout: 60_000,
    });
    try {
      await sender.verify();
    } catch (err) {
      sender.close();
      await client.logout().catch(() => client.close());
      throw loginError("SMTP", err, password);
    }
    return new ImapConnection(client, sender, password);
  },
};

const formatAddress = (address: MailAddress) => (address.name ? { name: address.name, address: address.address } : address.address);

/** Builds the raw message to send (no network): nodemailer's composer, with a fresh Message-ID. */
export async function composeMail(draft: {
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  subject: string;
  text: string;
  inReplyTo?: string | null;
  references?: string[];
}): Promise<{ raw: Buffer; messageId: string }> {
  const composer = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "windows" });
  const info = await composer.sendMail({
    from: formatAddress(draft.from),
    to: draft.to.map(formatAddress),
    ...(draft.cc.length ? { cc: draft.cc.map(formatAddress) } : {}),
    subject: draft.subject,
    text: draft.text,
    ...(draft.inReplyTo ? { inReplyTo: draft.inReplyTo } : {}),
    ...(draft.references?.length ? { references: draft.references } : {}),
  });
  return { raw: info.message as Buffer, messageId: info.messageId };
}
