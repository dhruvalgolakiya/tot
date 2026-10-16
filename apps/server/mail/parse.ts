import { simpleParser, type AddressObject, type HeaderLines } from "mailparser";
import type { MailAddress } from "../../shared/types.ts";

/**
 * Turns a raw email into what TOT stores: plain text, the sign-in codes and links in it, and
 * whether the receiving provider vouched for its sender. Everything here is pure (no I/O).
 */

/** Bodies are cut here; sign-up mails and tasks are far smaller. */
const MAX_TEXT_CHARS = 200_000;
const MAX_CODES = 5;
const MAX_LINKS = 25;

export interface ParsedEmail {
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  subject: string;
  text: string;
  links: { text: string; url: string }[];
  codes: string[];
  attachments: { name: string; size: number; contentType: string }[];
  /** The Date header (ms), when it has one. */
  date: number | null;
  authenticated: boolean;
  automated: boolean;
}

function addresses(value: AddressObject | AddressObject[] | undefined): MailAddress[] {
  const out: MailAddress[] = [];
  const walk = (list: { address?: string; name?: string; group?: unknown[] }[]) => {
    for (const entry of list) {
      if (entry.group) walk(entry.group as typeof list);
      else if (entry.address) out.push({ name: entry.name?.trim() || null, address: entry.address.trim().toLowerCase() });
    }
  };
  for (const object of Array.isArray(value) ? value : value ? [value] : []) walk(object.value);
  return out;
}

const ids = (value: string | string[] | undefined) =>
  (Array.isArray(value) ? value : value ? value.split(/\s+/) : []).map((id) => id.trim()).filter(Boolean);

/** The raw value of each header with this (lowercase) name, top to bottom, unfolded. */
function headerValues(lines: HeaderLines, key: string): string[] {
  return lines
    .filter((header) => header.key === key)
    .map((header) => header.line.slice(header.line.indexOf(":") + 1).replace(/\r?\n[ \t]+/g, " ").trim());
}

export async function parseMail(source: Buffer | string, opts: { authserv?: RegExp | null } = {}): Promise<ParsedEmail> {
  const parsed = await simpleParser(source, { skipImageLinks: true, skipTextToHtml: true, skipTextLinks: true });
  const from = addresses(parsed.from)[0] ?? { name: null, address: "unknown" };
  const subject = parsed.subject?.trim() || "(no subject)";
  const text = (parsed.text ?? "").replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, MAX_TEXT_CHARS);
  const html = typeof parsed.html === "string" ? parsed.html : "";
  return {
    messageId: parsed.messageId?.trim() || null,
    inReplyTo: ids(parsed.inReplyTo)[0] ?? null,
    references: ids(parsed.references),
    from,
    to: addresses(parsed.to),
    cc: addresses(parsed.cc),
    subject,
    text,
    links: findLinks(html, html ? "" : text),
    codes: findCodes(subject, text),
    attachments: parsed.attachments
      .filter((file) => file.contentDisposition === "attachment" || (file.filename && !file.related))
      .map((file) => ({ name: file.filename ?? "attachment", size: file.size, contentType: file.contentType })),
    date: parsed.date && !Number.isNaN(parsed.date.getTime()) ? parsed.date.getTime() : null,
    authenticated: senderAuthenticated(parsed.headerLines, from.address, opts.authserv ?? null),
    automated: isAutomated(parsed.headerLines, from.address),
  };
}

// ---------------------------------------------------------------------------
// Sender authentication. A From header is trivial to forge, so emailed tasks need the
// receiving provider's verdict: its Authentication-Results header (the topmost one, which
// it adds on arrival; any lower ones came with the message and prove nothing) must show
// dmarc=pass, or dkim=pass for a domain aligned with the From address's domain.
// ---------------------------------------------------------------------------

const domainOf = (address: string) => address.slice(address.lastIndexOf("@") + 1).toLowerCase().replace(/\.$/, "");

/** Relaxed alignment: the same domain, or one a subdomain of the other (never a bare TLD). */
function aligned(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const [long, short] = a.length > b.length ? [a, b] : [b, a];
  return short.includes(".") && long.endsWith(`.${short}`);
}

export function senderAuthenticated(lines: HeaderLines, fromAddress: string, authserv: RegExp | null): boolean {
  const top = headerValues(lines, "authentication-results")[0];
  if (!top) return false;
  // Comments like "(google.com: domain of … designates …)" may hold anything, semicolons included.
  let value = top;
  for (let i = 0; i < 3; i++) value = value.replace(/\([^()]*\)/g, " ");
  const [first = "", ...rest] = value.split(";");
  // "mx.google.com; dkim=pass …" starts with who checked; Outlook's starts right with the results.
  const authservId = first.includes("=") ? null : first.trim().split(/\s+/)[0]!.toLowerCase();
  if (authserv && !(authservId && authserv.test(authservId))) return false;
  const fromDomain = domainOf(fromAddress);
  for (const part of authservId === null ? [first, ...rest] : rest) {
    const result = /^\s*(dmarc|dkim)\s*=\s*([a-z]+)/i.exec(part);
    if (!result || result[2]!.toLowerCase() !== "pass") continue;
    if (result[1]!.toLowerCase() === "dmarc") {
      const headerFrom = /\bheader\.from\s*=\s*([^\s;]+)/i.exec(part)?.[1];
      if (!headerFrom || domainOf(headerFrom) === fromDomain) return true;
    } else {
      const signer = /\bheader\.d\s*=\s*([^\s;]+)/i.exec(part)?.[1] ?? /\bheader\.i\s*=\s*([^\s;]+)/i.exec(part)?.[1];
      if (signer && aligned(domainOf(signer), fromDomain)) return true;
    }
  }
  return false;
}

/** Auto-replies, bounces and bulk or mailing-list mail: never tasks, and never answered. */
export function isAutomated(lines: HeaderLines, fromAddress: string): boolean {
  const first = (key: string) => headerValues(lines, key)[0]?.toLowerCase() ?? "";
  const autoSubmitted = first("auto-submitted");
  if (autoSubmitted && !autoSubmitted.startsWith("no")) return true;
  if (/\b(bulk|list|junk|auto_reply)\b/.test(first("precedence"))) return true;
  if (headerValues(lines, "list-id").length) return true;
  if (headerValues(lines, "x-autoreply").length || headerValues(lines, "x-autorespond").length) return true;
  if (first("return-path") === "<>") return true;
  const local = fromAddress.slice(0, fromAddress.lastIndexOf("@")).toLowerCase();
  return /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounces?)([+._-].*)?$/.test(local);
}

// ---------------------------------------------------------------------------
// Sign-in codes: 4–8 digits ("482913", "123 456", "G-482913") or short uppercase codes ("Q7X-4MZ",
// "A1B2C3"), next to words like "code" or "verify" — on the same line, or alone on a line
// under such words. Years, dates, times, prices, phone and order numbers don't count.
// ---------------------------------------------------------------------------

const CODE_WORDS =
  /\b(codes?|verification|verify|verifying|otp|one[- ]?time|passcode|pin|sign[- ]?in|signing in|log[- ]?in|login|confirm|confirmation|launch|security|2fa|two[- ]factor|authenticat\w*)\b/i;
const CANDIDATE =
  /(?<![\w@#$€£¥+./-])(?<!\d[:,])(?<!\d\s)(\d{3}[- ]\d{3}|\d{4}[- ]\d{4}|\d{4,8}|[A-Z]{1,3}-\d{4,8}|(?=[A-Z0-9-]*[A-Z])[A-Z0-9]{3,4}-[A-Z0-9]{3,4}|(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{5,8})(?![\w@/:%€$£-]|[.,]\d|\s\d|\s?(?:usd|eur|gbp|dollars?)\b)/gi;
/** Words right before a number that make it something other than a code. */
const NOT_A_CODE_BEFORE =
  /(\b(order|invoice|receipt|account|acct|reference|ref|tracking|ticket|case|zip|postal|phone|mobile|tel|fax|call|suite|apt|unit|id)\b\W{0,3}(number|no\.?|#)?\W{0,3}|[$€£¥]\s?)$/i;
/** A US state before a 5-digit number: a zip code. */
const STATE_BEFORE = /\b[A-Z]{2}\s$/;
const URL_IN_TEXT = /\bhttps?:\/\/[^\s<>"')\]]+/gi;

function isCode(token: string, before: string): boolean {
  // Lowercase-only letters are words, not codes ("ABC-123" yes, "abc-def" no).
  if (/[a-z]/.test(token)) return false;
  const digits = token.replace(/\D/g, "");
  if (/^\d{4}$/.test(token) && Number(token) >= 1900 && Number(token) <= 2099) return false;
  if (/^\d+$/.test(token) && digits.length === 5 && STATE_BEFORE.test(before)) return false;
  return !NOT_A_CODE_BEFORE.test(before);
}

export function findCodes(subject: string, text: string): string[] {
  const found: string[] = [];
  const add = (token: string) => {
    const code = token.replace(/ /g, "");
    if (!found.includes(code) && found.length < MAX_CODES) found.push(code);
  };
  const subjectHasWord = CODE_WORDS.test(subject);
  const lines = [subject, ...text.split("\n")].map((line) => line.replace(URL_IN_TEXT, " "));
  lines.forEach((line, index) => {
    for (const match of line.matchAll(CANDIDATE)) {
      const token = match[1]!;
      const at = match.index!;
      const before = line.slice(Math.max(0, at - 30), at);
      if (!isCode(token, before)) continue;
      const near = line.slice(Math.max(0, at - 100), at + token.length + 40);
      const alone = line.replace(/^[\s:*•·>-]+|[\s.!:*]+$/g, "") === token;
      const above = lines.slice(Math.max(1, index - 3), index).some((l) => CODE_WORDS.test(l));
      if (CODE_WORDS.test(near) || (alone && index > 0 && (above || subjectHasWord))) add(token);
    }
  });
  return found;
}

// ---------------------------------------------------------------------------
// Links: anchor text and URL, deduped; verify / sign-in / magic / invite links first.
// Image-only links (logos, tracking pixels) are dropped.
// ---------------------------------------------------------------------------

const IMPORTANT_LINK = /verif|confirm|sign[- ]?in|sign[- ]?up|log[- ]?in|login|magic|activat|accept|join|invit|auth|password|reset/i;
const IMAGE_URL = /\.(png|gif|jpe?g|webp|svg|bmp)(\?|#|$)/i;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1]?.toLowerCase() === "x" ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

const stripTags = (html: string) => html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]*>/g, " ");

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function findLinks(html: string, text: string): { text: string; url: string }[] {
  const links = new Map<string, string>();
  const add = (url: string, label: string) => {
    url = url.trim();
    if (!/^https?:\/\//i.test(url) || IMAGE_URL.test(url) || url.length > 2000) return;
    const clean = label.replace(/\s+/g, " ").trim().slice(0, 120);
    if (!links.has(url) || (!links.get(url) && clean)) links.set(url, clean);
  };
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi)) {
    const attrs = match[1]!;
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attrs);
    const url = decode(href?.[1] ?? href?.[2] ?? href?.[3] ?? "");
    const label = decode(stripTags(match[2]!)).trim();
    if (!label && /<img\b/i.test(match[2]!)) continue;
    add(url, label || decode(/\btitle\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ?? ""));
  }
  const lines = text.split("\n");
  lines.forEach((line, index) => {
    for (const match of line.matchAll(URL_IN_TEXT)) {
      const url = match[0].replace(/[.,;:!?]+$/, "");
      let label = line.slice(0, match.index).replace(/[\s:([<\-–—]+$/, "").trim().slice(-80);
      if (!label) label = lines.slice(Math.max(0, index - 1), index).find((l) => l.trim() && l.length < 80)?.trim() ?? "";
      add(url, label);
    }
  });
  const list = [...links].map(([url, label]) => ({ text: label || hostOf(url), url }));
  const rank = (link: { text: string; url: string }) =>
    /unsubscribe|preferences/i.test(`${link.text} ${link.url}`) ? 2 : IMPORTANT_LINK.test(`${link.text} ${link.url}`) ? 0 : 1;
  return list.sort((a, b) => rank(a) - rank(b)).slice(0, MAX_LINKS);
}

/** An email's own words, without the quoted history replies carry ("On … wrote:", "> …"). */
export function stripQuoted(text: string): string {
  const lines = text.split("\n");
  const kept: string[] = [];
  for (const [i, line] of lines.entries()) {
    const next = lines[i + 1] ?? "";
    if (/^On .{4,200}wrote:\s*$/.test(line) || (/^On .{4,200}$/.test(line) && /^.{0,120}wrote:\s*$/.test(next))) break;
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(line)) break;
    if (/^From: /.test(line) && /^(Sent|Date): /.test(next)) break;
    if (/^_{8,}\s*$/.test(line) && /^From: /.test(next)) break;
    if (/^>/.test(line)) continue;
    kept.push(line);
  }
  return kept.join("\n").trim() || text.trim();
}
