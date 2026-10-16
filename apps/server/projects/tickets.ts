import type { ConversationOrigin } from "@tot/shared/types";
import { conversations } from "../data/conversations.ts";
import { projects } from "./projects.ts";

/**
 * Tickets (module 06): the Linear issue or GitHub issue / pull request a chat is about. Found by its
 * link, or by a bare Linear key like ENG-123 when a project takes that team's work. A chat's origin
 * keeps the ticket's key, and tasks started from the chat name their branches after it.
 */

export interface Ticket {
  kind: "linear" | "github";
  /** "ENG-123", or "acme/web#42". */
  key: string;
  /** The link; null for a bare key. */
  url: string | null;
  /** What the chat's chip shows: just the key, since the ticket's title isn't known. */
  label: string;
}

const LINEAR_URL = /https?:\/\/linear\.app\/[\w-]+\/issue\/([a-z][a-z0-9]*-\d+)(?:\/[\w-]+)?/gi;
const GITHUB_URL = /https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)/gi;
const BARE_KEY = /\b([A-Z][A-Z0-9]{0,9})-\d{1,7}\b/g;
/** How far up a task looks (its chat, that chat's chat…) for the ticket it works on. */
const MAX_DEPTH = 10;

const ticket = (kind: Ticket["kind"], key: string, url: string | null): Ticket => ({ kind, key, url, label: key });

/** The Linear teams some project takes work from (their keys, e.g. "ENG"). */
function intakeTeams(): string[] {
  return [...new Set(projects.list().flatMap((project) => project.intake.linearTeams))];
}

/**
 * The ticket a text is about: its first Linear or GitHub issue (or PR) link, else a bare key like
 * ENG-123 whose team is in `teams` ("UTF-8" and "GPT-5" aren't tickets). Null when there's none.
 */
export function detectTicket(text: string, teams: readonly string[] = intakeTeams()): Ticket | null {
  const links = [
    ...[...text.matchAll(LINEAR_URL)].map((m) => ({ at: m.index, ticket: ticket("linear", m[1]!.toUpperCase(), m[0]) })),
    ...[...text.matchAll(GITHUB_URL)].map((m) => ({ at: m.index, ticket: ticket("github", `${m[1]}/${m[2]}#${m[3]}`, m[0]) })),
  ];
  const first = links.sort((a, b) => a.at - b.at)[0];
  if (first) return first.ticket;
  for (const m of text.matchAll(BARE_KEY)) if (teams.includes(m[1]!)) return ticket("linear", m[0], null);
  return null;
}

/** A chat's origin for a ticket: the chip shows the key and links to the ticket. */
export function ticketOrigin(found: Ticket): ConversationOrigin {
  return { kind: found.kind, label: found.label, url: found.url, key: found.key };
}

/** The ticket a task works on: its own origin's key, else that of the nearest chat (or task) above it with one. */
export function ticketKeyOf(origin: ConversationOrigin | null | undefined, parentId: string | null | undefined): string | null {
  if (origin?.key) return origin.key;
  let id = parentId;
  for (let depth = 0; id && depth < MAX_DEPTH; depth++) {
    const above = conversations.get(id);
    if (above?.origin?.key) return above.origin.key;
    id = above?.parentId;
  }
  return null;
}
