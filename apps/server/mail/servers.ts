import type { MailboxConnectRequest, MailServer } from "../../shared/types.ts";

/** Mail providers whose IMAP/SMTP servers TOT knows, so connecting needs only the address and an app password. */

interface Provider {
  name: string;
  /** Address domains it hosts. */
  domains: RegExp;
  imap: MailServer;
  smtp: MailServer;
  /** Who writes the Authentication-Results header TOT trusts (the provider's own receiving servers), when known. */
  authserv?: RegExp;
}

const PROVIDERS: Provider[] = [
  {
    name: "Gmail",
    domains: /^(gmail|googlemail)\.com$/,
    imap: { host: "imap.gmail.com", port: 993 },
    smtp: { host: "smtp.gmail.com", port: 465 },
    authserv: /^mx\.google\.com$/,
  },
  {
    name: "Outlook",
    domains: /^(outlook|hotmail|live|msn)\.[a-z.]+$/,
    imap: { host: "outlook.office365.com", port: 993 },
    smtp: { host: "smtp-mail.outlook.com", port: 587 },
  },
  { name: "iCloud", domains: /^(icloud|me|mac)\.com$/, imap: { host: "imap.mail.me.com", port: 993 }, smtp: { host: "smtp.mail.me.com", port: 587 } },
  {
    name: "Yahoo",
    domains: /^(yahoo\.[a-z.]+|ymail\.com|rocketmail\.com)$/,
    imap: { host: "imap.mail.yahoo.com", port: 993 },
    smtp: { host: "smtp.mail.yahoo.com", port: 465 },
  },
  {
    name: "Fastmail",
    domains: /^fastmail\.(com|fm)$/,
    imap: { host: "imap.fastmail.com", port: 993 },
    smtp: { host: "smtp.fastmail.com", port: 465 },
    authserv: /\.messagingengine\.com$/,
  },
  { name: "Zoho", domains: /^zoho(mail)?\.com$/, imap: { host: "imap.zoho.com", port: 993 }, smtp: { host: "smtp.zoho.com", port: 465 } },
];

const domainOf = (email: string) => email.slice(email.lastIndexOf("@") + 1).toLowerCase();

const byImapHost = (host: string) => PROVIDERS.find((p) => p.imap.host === host.toLowerCase()) ?? null;

/** The receiving servers whose Authentication-Results to trust for a mailbox on this IMAP host, when known. */
export const trustedAuthserv = (imapHost: string): RegExp | null => byImapHost(imapHost)?.authserv ?? null;

export interface MailSettings {
  /** "Gmail", etc., or the IMAP host. */
  provider: string;
  imap: MailServer;
  smtp: MailServer;
  username: string;
  password: string;
}

function server(value: unknown): MailServer | null {
  const s = value as Partial<MailServer> | null | undefined;
  const host = typeof s?.host === "string" ? s.host.trim().toLowerCase() : "";
  const port = Number(s?.port);
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host, port };
}

/** Server settings for an address: the request's, or detected from the domain. A string is what's wrong. */
export function mailSettings(email: string, request: Partial<MailboxConnectRequest>): MailSettings | string {
  let password = typeof request.password === "string" ? request.password.trim() : "";
  if (!password) return "Enter the mailbox's app password.";
  const known = PROVIDERS.find((p) => p.domains.test(domainOf(email)));
  const imap = request.imap ? server(request.imap) : (known?.imap ?? null);
  const smtp = request.smtp ? server(request.smtp) : (known?.smtp ?? null);
  if (request.imap && !imap) return "The IMAP server needs a host name and a port (usually 993).";
  if (request.smtp && !smtp) return "The SMTP server needs a host name and a port (usually 465 or 587).";
  if (!imap || !smtp) return `TOT doesn't know the mail servers for ${domainOf(email)}. Enter its IMAP and SMTP servers.`;
  const provider = byImapHost(imap.host)?.name ?? imap.host;
  // Google shows app passwords in groups of four ("abcd efgh ijkl mnop"); IMAP wants them joined.
  if (provider === "Gmail") password = password.replace(/\s+/g, "");
  const username = typeof request.username === "string" && request.username.trim() ? request.username.trim() : email;
  return { provider, imap, smtp, username, password };
}
