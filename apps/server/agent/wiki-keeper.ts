import { randomUUID } from "node:crypto";
import type { Message, MessagePart, WikiPage } from "@tot/shared/types";
import { appEvents } from "../app-events.ts";
import { agents } from "../data/agents.ts";
import { brains, type AgentBrain } from "../data/brains.ts";
import { conversations } from "../data/conversations.ts";
import { db, type Row } from "../db.ts";
import { messageText, messages } from "../data/messages.ts";
import { settings } from "../data/settings.ts";
import { MAX_PAGE_CHARS, wiki, WikiError } from "../data/wiki.ts";
import { keeperKnowledge } from "../knowledge/auto/keeper.ts";
import { limits } from "./limits.ts";
import { providerStatuses, providers } from "./providers/index.ts";
import { CLAUDE_SONNET } from "./router.ts";
import { runRegistry } from "./runs.ts";

/**
 * The wiki keeper: once a chat has been quiet for a while, a light model reads
 * what's new in it and folds anything durable into the agent's brains (those it
 * may write to), so they stay current even when the agent didn't write things
 * down itself. New pages go to the chat's focus brain unless the model names another.
 * Each chat remembers how far it has been read (`wiki_synced_at`).
 */

const TICK_MS = 60_000;
/** A chat counts as quiet this long after its last message. */
const IDLE_MS = 5 * 60_000;
/** Less new text than this (e.g. "thanks!") isn't worth a pass. */
const MIN_NEW_CHARS = 400;
const MAX_NEW_CHARS = 30_000;
const EARLIER_CONTEXT_CHARS = 3000;
const PAGES_IN_FULL = 5;
const PAGES_BUDGET = 24_000;
const INDEX_BUDGET = 8000;
const MAX_UPDATES = 5;
/** After a failure (no provider, limit, bad reply), wait this long before trying the chat again… */
const RETRY_MS = 30 * 60_000;
/** …and give up on a chat's new messages after this many failures in a row. */
const MAX_ATTEMPTS = 3;

export type Complete = (prompt: string, system: string) => Promise<string>;

interface Update {
  page?: string;
  title: string;
  summary?: string;
  content: string;
  parent?: string | null;
  /** For a new page: the brain it belongs in (name or id). */
  brain?: string;
}

const SYSTEM = `You maintain the brains of an agent in TOT, an AI agent app. Brains are long-term knowledge bases (wikis) that agents and their user rely on in future chats: the agent's private notebook, and shared brains that each cover one repo, client or topic. You're given their current state and a chat that just went quiet. Fold anything durable the chat established into the right brain, then reply with JSON only.`;

const INSTRUCTIONS = `What to capture: durable knowledge future work needs — how systems and code work, decisions and their reasons, conventions, commands to run/test/deploy, gotchas and their fixes, services, accounts and people, where things live, and the status of ongoing work (what's done, what's next). Skip small talk, one-off answers, general knowledge, anything the wiki already says, and secrets (never copy passwords, tokens or keys).

Rules:
- Prefer updating a page shown in full above over creating a new one. You can only update pages whose full content is shown (by id). Return the complete new content of each page you update, keeping everything that's still true.
- Create a page only for a substantial new topic: a short title, a one-line summary, the brain it belongs in (knowledge about a shared brain's subject goes there; everything else in the notebook), and a parent id from that brain's index when it belongs under a page.
- Keep Overviews short. The notebook's: what the workspace is for, active projects and where they live, current status and next steps — update its status when the chat changed it. A shared brain's is its start-here guide.
- Write it as documentation, not as a story about the chat ("the user said…"). Markdown, scannable, file paths in backticks.
- Usually 0–2 updates; at most ${MAX_UPDATES}.

Reply with JSON only, no prose:
{"updates": [{"page": "<id of a page shown in full, or omit to create>", "title": "...", "summary": "...", "content": "...", "brain": "<for a new page: brain name>", "parent": "<parent page id, or null>"}]}
If nothing is worth keeping: {"updates": []}`;

let timer: NodeJS.Timeout | null = null;
let busy = false;
const failures = new Map<string, { count: number; retryAt: number }>();

/** One line per message; tool calls condensed to their titles. */
function render(message: Message): string {
  const text = messageText(message);
  const tools = message.parts
    .filter((part): part is Extract<MessagePart, { type: "tool" }> => part.type === "tool")
    .map((part) => part.title ?? part.name);
  const used = tools.length ? `\n[tools: ${[...new Set(tools)].slice(0, 20).join("; ")}]` : "";
  if (!text && !used) return "";
  return `${message.role === "user" ? "User" : "Agent"}: ${text}${used}`;
}

function clipMiddle(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.3);
  return `${text.slice(0, head)}\n… (${text.length - max} characters omitted) …\n${text.slice(-(max - head))}`;
}

/** Pages the agent touched in the chat, then the ones most related to it, within budget. */
function pagesInFull(scope: string[], chat: Message[], text: string): WikiPage[] {
  const touched: WikiPage[] = [];
  for (const message of chat) {
    for (const part of message.parts) {
      if (part.type !== "tool" || !part.name.startsWith("wiki_") || !part.input || typeof part.input !== "object") continue;
      const input = part.input as Record<string, unknown>;
      const ref = typeof input.page === "string" ? input.page : typeof input.title === "string" ? input.title : null;
      try {
        const page = ref ? wiki.find(scope, ref) : null;
        if (page) touched.push(page);
      } catch {
        // An ambiguous title; the relevance search below still covers it.
      }
    }
  }
  const byId = new Map<string, WikiPage>();
  for (const page of [...touched, ...wiki.relevant(scope, text, PAGES_IN_FULL)]) {
    if (!page.pinned) byId.set(page.id, page);
  }
  const picked: WikiPage[] = [];
  let used = 0;
  for (const page of byId.values()) {
    if (picked.length === PAGES_IN_FULL) break;
    if (used + page.content.length > PAGES_BUDGET) continue;
    used += page.content.length;
    picked.push(page);
  }
  return picked;
}

const brainName = (brain: AgentBrain) => (brain.kind === "notebook" ? "notebook" : brain.name);

function pageBlock(page: WikiPage, mine: AgentBrain[]): string {
  const parent = page.parentId ? wiki.get(page.parentId) : null;
  const brain = mine.find((b) => b.id === page.brainId);
  return `<page id="${page.id}" title="${page.title}"${brain && mine.length > 1 ? ` brain="${brainName(brain)}"` : ""}${parent ? ` parent="${parent.title}"` : ""} summary="${page.summary}">\n${page.content || "(empty)"}\n</page>`;
}

/** The brains the keeper may write to, notebook first, and the one new pages default to (in a project, its knowledge). */
function keeperBrains(agentId: string, conversationId: string): { writable: AgentBrain[]; home: AgentBrain } {
  const writable = brains.forAgent(agentId).filter((brain) => brain.access === "write");
  const focus = keeperKnowledge.homeBrain(conversationId) ?? brains.focus(conversationId);
  return { writable, home: writable.find((brain) => brain.id === focus) ?? writable[0] };
}

/** Pages the keeper may update, with the version it was shown (to skip pages edited meanwhile). */
export type Editable = Map<string, number>;

export function buildKeeperPrompt(
  agentId: string,
  conversationId: string,
  title: string,
  earlier: Message[],
  fresh: Message[],
): { prompt: string; editable: Editable } {
  const { writable, home } = keeperBrains(agentId, conversationId);
  const overviews = [...new Map([writable[0], home].map((brain) => [brain.id, wiki.overview(brain.id)])).values()];
  const freshText = clipMiddle(fresh.map(render).filter(Boolean).join("\n\n"), MAX_NEW_CHARS);
  const earlierText = earlier.map(render).filter(Boolean).join("\n\n").slice(-EARLIER_CONTEXT_CHARS);
  const full = pagesInFull(
    writable.map((brain) => brain.id),
    fresh,
    fresh.map(messageText).join("\n"),
  );
  // Page indexes of the notebook and the chat's focus brain; other brains by their card.
  let used = 0;
  const indexes = writable.map((brain) => {
    const card = `${brainName(brain)}${brain.id === home.id ? " (default for new pages)" : ""}${brain.description ? ` — ${brain.description}` : ""}`;
    const lines: string[] = [];
    if (brain.id === writable[0].id || brain.id === home.id) {
      for (const p of wiki.outline(brain.id)) {
        const line = `${"  ".repeat(p.depth)}- ${p.title} (${p.id})${p.summary ? ` — ${p.summary}` : ""}`;
        if ((used += line.length) > INDEX_BUDGET) break;
        lines.push(line);
      }
    }
    return `<brain name="${brainName(brain)}">\n${card}${lines.length ? `\n${lines.join("\n")}` : ""}\n</brain>`;
  });

  const prompt = `<brains>
${indexes.join("\n")}
</brains>
<pages>
${[...overviews, ...full].map((page) => pageBlock(page, writable)).join("\n")}
</pages>

<chat title="${title}">
${earlierText ? `<earlier_context note="already folded into the wiki; for context only">\n${earlierText}\n</earlier_context>\n` : ""}<new_messages>
${freshText}
</new_messages>
</chat>

${INSTRUCTIONS}`;
  return { prompt, editable: new Map([...overviews, ...full].map((page) => [page.id, page.updatedAt])) };
}

/** Pulls the updates out of the model's reply (tolerates code fences and stray prose). */
export function parseUpdates(raw: string): Update[] {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("The keeper's reply had no JSON.");
  const parsed = JSON.parse(raw.slice(start, end + 1)) as { updates?: unknown };
  if (!Array.isArray(parsed.updates)) throw new Error("The keeper's reply had no updates list.");
  const optional = (value: unknown) => (typeof value === "string" && value.trim() ? value : undefined);
  const updates: Update[] = [];
  for (const item of parsed.updates.slice(0, MAX_UPDATES)) {
    const v = (item ?? {}) as Record<string, unknown>;
    if (typeof v.title !== "string" || typeof v.content !== "string") continue;
    updates.push({
      title: v.title,
      content: v.content,
      page: optional(v.page),
      summary: optional(v.summary),
      parent: optional(v.parent),
      brain: optional(v.brain),
    });
  }
  return updates;
}

/** Applies updates the keeper is allowed to make; returns the pages that changed. */
export function applyUpdates(
  agentId: string,
  conversationId: string,
  updates: Update[],
  editable: Editable,
): { changed: WikiPage[]; created: boolean } {
  const { writable, home } = keeperBrains(agentId, conversationId);
  const changed: WikiPage[] = [];
  let created = false;
  for (const update of updates) {
    const content = update.content.trim().slice(0, MAX_PAGE_CHARS);
    try {
      if (update.page) {
        const page = editable.has(update.page) ? wiki.get(update.page) : null;
        // Gone, or edited (by the user or a chat) since the keeper read it: never overwrite that.
        if (!page || page.updatedAt !== editable.get(page.id)) continue;
        // Guard against a model that "summarizes" a long page away.
        if (page.content.length > 1500 && content.length < page.content.length * 0.4) continue;
        if (content === page.content && (update.summary ?? page.summary) === page.summary) continue;
        changed.push(
          wiki.update(
            page.id,
            { content, summary: update.summary, ...(page.pinned ? {} : { title: update.title }) },
            "keeper",
            conversationId,
          ),
        );
      } else {
        if (!update.summary || !content) continue;
        const named = update.brain ? brains.resolve(agentId, update.brain) : null;
        const brainId = named && writable.some((brain) => brain.id === named.id) ? named.id : home.id;
        let parentId: string | null = null;
        try {
          parentId = update.parent ? (wiki.find(brainId, update.parent)?.id ?? null) : null;
        } catch {
          // An ambiguous parent title: create it at the top level instead.
        }
        changed.push(wiki.create(brainId, { title: update.title, summary: update.summary, content, parentId }, "keeper", conversationId));
        created = true;
      }
    } catch (err) {
      // A clashing title, an over-long field, anything odd: skip that one update, keep the rest.
      if (!(err instanceof WikiError)) console.warn("[tot] wiki keeper skipped an update:", err);
    }
  }
  return { changed, created };
}

/** The light model (Sonnet, then ChatGPT), for background jobs: the keeper, and memory's Dreaming (module 10). */
export async function defaultComplete(prompt: string, system: string): Promise<string> {
  const statuses = await providerStatuses();
  const limited = limits.active();
  const candidates = (["claude", "chatgpt"] as const).filter(
    (id) => statuses.find((s) => s.id === id)?.loggedIn && !limited.has(id),
  );
  if (!candidates.length) throw new Error("No provider available for a background job (the wiki keeper or Dreaming).");
  let lastError: unknown;
  for (const id of candidates) {
    try {
      return await providers[id].complete(prompt, {
        model: id === "claude" ? CLAUDE_SONNET : undefined,
        system,
        signal: AbortSignal.timeout(180_000),
      });
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

const markSynced = (conversationId: string, at: number) =>
  db.prepare(`UPDATE conversations SET wiki_synced_at = ? WHERE id = ?`).run(at, conversationId);

/** Reads what's new in one chat and updates the wiki. Exported for tests. */
export async function keepConversation(conversationId: string, complete: Complete = defaultComplete): Promise<WikiPage[]> {
  const conversation = conversations.get(conversationId);
  if (!conversation || !agents.get(conversation.agentId)) return [];
  const syncedAt = Number((db.prepare(`SELECT wiki_synced_at FROM conversations WHERE id = ?`).get(conversationId) as Row).wiki_synced_at);
  const all = messages.listByConversation(conversationId).filter((m) => m.status !== "streaming");
  const fresh = all.filter((m) => m.createdAt > syncedAt);
  if (!fresh.length) return [];
  const lastAt = Math.max(...fresh.map((m) => m.createdAt));

  const newChars = fresh.reduce((sum, m) => sum + messageText(m).length, 0);
  // Module 11: a task whose landing updated the project's knowledge (or is about to) is left to that.
  if (!settings.get().memory.enabled || newChars < MIN_NEW_CHARS || keeperKnowledge.covered(conversationId, lastAt)) {
    markSynced(conversationId, lastAt);
    return [];
  }

  const earlier = all.filter((m) => m.createdAt <= syncedAt);
  const { prompt, editable } = buildKeeperPrompt(conversation.agentId, conversationId, conversation.title, earlier, fresh);
  const updates = parseUpdates(await complete(prompt, SYSTEM));
  // The chat may have been deleted while the model was working.
  if (!conversations.get(conversationId)) return [];
  const projectRun = await keeperKnowledge.begin(conversationId, editable.keys());
  const { changed, created } = applyUpdates(conversation.agentId, conversationId, updates, editable);
  await projectRun?.finish(changed, conversation.title);
  markSynced(conversationId, lastAt);
  if (!changed.length) return [];

  // A quiet note at the end of the chat, linking to what changed.
  const lastAssistant = [...all].reverse().find((m) => m.role === "assistant");
  if (lastAssistant) {
    const titles = [...new Set(changed.map((page) => page.title))];
    lastAssistant.parts.push({
      type: "notice",
      id: randomUUID(),
      kind: "wiki",
      text: `Updated the wiki: ${titles.join(", ")}`,
      pageIds: [...new Set(changed.map((page) => page.id))],
    });
    messages.save(lastAssistant);
  }
  const changedBrains = [...new Set(changed.map((page) => page.brainId))];
  for (const brainId of changedBrains) appEvents.brainChanged(brainId, { conversationId });
  if (created) appEvents.brainsChanged();
  return changed;
}

/**
 * Chats with messages the keeper hasn't read yet that have been quiet for a while
 * (by updated_at, which a turn bumps when it ends), oldest first.
 */
function dueConversations(now: number): string[] {
  const waiting = [...failures].filter(([, f]) => f.retryAt > now).map(([id]) => id);
  const rows = db
    .prepare(
      `SELECT c.id FROM conversations c JOIN messages m ON m.conversation_id = c.id
       WHERE m.status != 'streaming' AND c.updated_at < ? AND c.id NOT IN (SELECT value FROM json_each(?))
       GROUP BY c.id HAVING MAX(m.created_at) > c.wiki_synced_at
       ORDER BY c.updated_at LIMIT 20`,
    )
    .all(now - IDLE_MS, JSON.stringify(waiting)) as Row[];
  return rows.map((row) => String(row.id)).filter((id) => !runRegistry.activeFor(id));
}

async function tick(): Promise<void> {
  if (busy) return;
  busy = true;
  let id: string | undefined;
  try {
    // One chat per tick keeps the keeper's use of the user's plan gentle.
    [id] = dueConversations(Date.now());
    if (!id) return;
    await keepConversation(id);
    failures.delete(id);
  } catch (err) {
    console.warn(`[tot] wiki keeper skipped a chat for now:`, err instanceof Error ? err.message : err);
    if (id) {
      const count = (failures.get(id)?.count ?? 0) + 1;
      if (count >= MAX_ATTEMPTS) {
        // Give up on what's there now; newer messages get a fresh try.
        failures.delete(id);
        db.prepare(
          `UPDATE conversations SET wiki_synced_at = (SELECT COALESCE(MAX(created_at), 0) FROM messages WHERE conversation_id = ?) WHERE id = ?`,
        ).run(id, id);
      } else {
        failures.set(id, { count, retryAt: Date.now() + RETRY_MS });
      }
    }
  } finally {
    busy = false;
  }
}

export const wikiKeeper = {
  start(): void {
    if (timer) return;
    timer = setInterval(() => void tick(), TICK_MS);
    timer.unref();
  },

  stop(): void {
    if (timer) clearInterval(timer);
    timer = null;
  },
};
