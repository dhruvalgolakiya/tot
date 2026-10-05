import { getSecret, secretValues } from "../config.ts";
import { redactGitHubTokens } from "../github.ts";

/**
 * What a secret looks like (API keys, Slack tokens, AWS keys, private keys): shared by the scrubber for check
 * output (shell.ts) and by memory, which refuses to store anything that matches and hides it wherever memory
 * text is shown to an agent (roadmap module 10).
 */
export const SECRET_SHAPES = [
  /\bsk-ant-[\w-]{20,}/g,
  /\bsk-(?:proj-)?[\w-]{32,}/g,
  /\bxox[abprs]-[\w-]{10,}/g,
  /\bxapp-[\w-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

const HIDDEN = "[secret hidden]";

/** TOT's own secrets (GitHub tokens, API keys, mailbox passwords, device tokens). */
const heldSecrets = () => [...secretValues(""), getSecret("anthropicApiKey"), getSecret("boatApiKey")].filter((secret): secret is string => Boolean(secret && secret.length >= 8));

/** Hides every secret TOT holds (GitHub tokens, API keys, mailbox passwords) and anything shaped like a key. */
export function scrub(text: string): string {
  let out = redactGitHubTokens(text);
  for (const secret of heldSecrets()) out = out.split(secret).join(HIDDEN);
  // Token shapes are worth hiding even when TOT doesn't hold the token itself.
  for (const shape of SECRET_SHAPES) out = out.replace(shape, HIDDEN);
  return out;
}

/** "My password is …", "api key: …": a keyword, then what follows it. */
const PASSWORD_LIKE = /\b(password|passwd|passcode|pin code|pin|api[ _-]?key|secret key|access token|private key)\s*(?:is|:|=)\s*["'`]?([^\s"'`]+)/gi;

function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) bits -= (count / value.length) * Math.log2(count / value.length);
  return bits;
}

/**
 * Whether what follows "password is" looks like the password itself rather than words about it ("managed by
 * Bitwarden"): no spaces, 8 characters or more, and mixed kinds of characters or random-looking. A PIN is digits.
 */
function tokenLike(keyword: string, value: string): boolean {
  const clean = value.replace(/[.,;!?)]+$/, "");
  if (/^(pin|pin code|passcode)$/i.test(keyword) && /^\d{4,}$/.test(clean)) return true;
  if (clean.length < 8) return false;
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((kind) => kind.test(clean)).length;
  return kinds >= 2 || (clean.length >= 12 && entropy(clean) >= 3.5);
}

/** The password-like values in some text (see `tokenLike`). */
function passwordValues(text: string): string[] {
  return [...text.matchAll(PASSWORD_LIKE)].filter((match) => tokenLike(match[1]!, match[2]!)).map((match) => match[2]!.replace(/[.,;!?)]+$/, ""));
}

/**
 * What kind of secret some text holds: "key" for anything shaped like a key or one of TOT's own secrets (never
 * stored), "password" for a password written out after "password is" (stored only when the user says so), or null.
 */
export function secretKind(text: string): "key" | "password" | null {
  if (redactGitHubTokens(text) !== text) return "key";
  if (SECRET_SHAPES.some((shape) => new RegExp(shape.source).test(text))) return "key";
  if (heldSecrets().some((secret) => text.includes(secret))) return "key";
  return passwordValues(text).length ? "password" : null;
}

/** `scrub`, and the passwords written out after "password is": for memory text shown to agents and in history. */
export function hideSecrets(text: string): string {
  let out = scrub(text);
  for (const value of passwordValues(out)) out = out.split(value).join(HIDDEN);
  return out;
}
