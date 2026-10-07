import type { LeadSignal, Message, MessagePart, Project } from "../../shared/types.ts";
import { brains } from "../data/brains.ts";
import type { ConversationRecord } from "../data/conversations.ts";
import { messages, messageText } from "../data/messages.ts";
import { settings } from "../data/settings.ts";
import { wiki } from "../data/wiki.ts";
import { db, type Row } from "../db.ts";
import { promptMemory } from "../memory/prompt.ts";
import { projects } from "../projects/projects.ts";
import { leadSignals } from "../signals/store.ts";
import { taskStore } from "../tasks/store.ts";
import { projectBoardText } from "./board.ts";

/**
 * A lean Lead (roadmap module 12, lane C). A project's Lead runs for months, so it doesn't carry an ever-growing
 * transcript: when its last turn ran with more than ~120k tokens of context, its next turn starts a fresh provider
 * session (as a task's does, tasks/run-loop.ts FRESH_SESSION_TOKENS) with the project's state up front instead: the
 * board, its unread and recent signals, the cards waiting for the user, the knowledge's MEMORY.md and Overview, and
 * its last few messages, clipped. Older messages stay readable with chat_read. `leadPreamble` is pure (it only
 * formats); `leadSession.freshStart` gathers the state when a Lead's turn begins (agent/orchestrator.ts).
 */

/** Past this much context in its last turn, a Lead's next turn starts a fresh session (TOT_LEAD_FRESH_TOKENS overrides it, for a live run). */
export const LEAD_FRESH_TOKENS = Number(process.env.TOT_LEAD_FRESH_TOKENS) || 120_000;

const BOARD_MAX = 8000;
const SIGNALS_UNREAD = 12;
const SIGNALS_EARLIER = 6;
const SIGNAL_DETAIL_MAX = 300;
const OVERVIEW_MAX = 1500;
const LAST_MESSAGES = 6;
const MESSAGE_MAX = 1500;
const MESSAGES_MAX = 6000;

/** A card in the Lead's chat still waiting for the user's answer (a land, discard or push request, server/lead/asks.ts). */
export interface LeadCard {
  /** What the card asks, its first line, e.g. "Merge “Fix cart” into main? · +14 −1 · checks passing". */
  text: string;
  taskId: string;
  at: number;
}

/** What a fresh session starts from. */
export interface LeadState {
  projectName: string;
  chatId: string;
  /** The context the last turn ran with, in tokens. */
  contextTokens: number;
  /** mission_overview's text (board.ts). */
  board: string;
  /** Newest first. */
  signals: LeadSignal[];
  cards: LeadCard[];
  /** The project's MEMORY.md as the prompt shows it (null with memory off). */
  memory: { repo: string; content: string } | null;
  overview: { summary: string; content: string } | null;
  /** The chat so far (its last few messages are carried over). */
  history: Message[];
  now: number;
}

/**
 * The context the Lead's last turn ran with, in tokens; null before it has a turn with usage. A provider reports a
 * turn's input summed over every model call in it (each call reads the whole session again, cache reads included),
 * so it's divided by the calls the turn made: one, plus one per tool call.
 */
export function lastTurnContext(history: Message[]): number | null {
  const last = history.findLast((m) => m.role === "assistant" && typeof m.usage?.inputTokens === "number");
  if (!last) return null;
  const calls = 1 + last.parts.filter((part) => part.type === "tool").length;
  return Math.round(last.usage!.inputTokens! / calls);
}

const clip = (text: string, max: number, more = "…") => (text.length > max ? `${text.slice(0, max - more.length - 1).trimEnd()} ${more}` : text);

const firstLines = (text: string, lines: number, max: number) =>
  clip(
    text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, lines)
      .join(" / "),
    max,
  );

/** "just now", "12 min ago", "3 h ago", "2 days ago". */
function ago(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

function signalLine(signal: LeadSignal, now: number): string {
  const parts = [
    signal.kind,
    ago(signal.at, now),
    clip(signal.title, 200),
    signal.repoName && `repo ${signal.repoName}`,
    signal.prNumber != null && !signal.title.includes(`#${signal.prNumber}`) && `PR #${signal.prNumber}`,
    signal.taskId && `task ${signal.taskId}`,
    signal.url,
  ].filter(Boolean);
  const detail = signal.detail?.trim() ? `\n  ${firstLines(signal.detail, 3, SIGNAL_DETAIL_MAX)}` : "";
  return `- ${parts.join(" · ")}${detail}`;
}

function signalsBlock(signals: LeadSignal[], now: number): string {
  // New ones aren't repeated here: this turn's own note lists them (tasks/prompt.ts childResultsNote) and marks them read.
  const unread = signals.filter((signal) => signal.readAt === null).length;
  const earlier = signals.filter((signal) => signal.readAt !== null).slice(0, SIGNALS_EARLIER);
  if (!unread && !earlier.length) return "None yet.";
  const out: string[] = [];
  if (unread) out.push(`New (${unread}): listed in this turn's note, after this state.`);
  if (earlier.length) out.push(`Earlier, already seen (${earlier.length}):\n${earlier.map((signal) => signalLine(signal, now)).join("\n")}`);
  return out.join("\n");
}

function cardsBlock(cards: LeadCard[], now: number): string {
  if (!cards.length) return "None.";
  return `Waiting for the user's answer; don't ask again:\n${cards.map((card) => `- ${card.text} (task ${card.taskId}, asked ${ago(card.at, now)})`).join("\n")}`;
}

function knowledgeBlock(state: LeadState): string {
  const out: string[] = [];
  if (state.memory) out.push(`MEMORY.md (${state.memory.repo}):\n${state.memory.content.trim() || "(nothing yet)"}`);
  if (state.overview) {
    const content = state.overview.content.trim();
    out.push(
      `Overview: ${state.overview.summary.trim() || "(no summary)"}${
        content ? `\n${clip(content, OVERVIEW_MAX, "… (the whole Overview: your Project section, or wiki_read)")}` : "\n(empty)"
      }`,
    );
  }
  return out.join("\n\n") || "Nothing yet.";
}

type Notice = Extract<MessagePart, { type: "notice" }>;

/** The chat's last few messages that say something, oldest first, each clipped: the user's, TOT's own (a wake), replies, and notices. */
function lastMessages(history: Message[], chatId: string): string {
  const said: string[] = [];
  for (let i = history.length - 1; i >= 0 && said.length < LAST_MESSAGES; i--) {
    const message = history[i]!;
    const text = messageText(message);
    const notices = message.parts.filter((part): part is Notice => part.type === "notice").map((part) => part.text);
    const tag = message.role === "user" ? (message.auto ? "tot" : "user") : text ? "assistant" : "notice";
    const body = text || (message.role === "assistant" ? notices.join("\n") : "");
    if (!body) continue;
    said.unshift(`<${tag}>\n${clip(body, MESSAGE_MAX, `… [cut: chat_read { chatId: "${chatId}" } for all of it]`)}\n</${tag}>`);
  }
  while (said.length > 1 && said.join("\n").length > MESSAGES_MAX) said.shift();
  return said.length ? said.join("\n") : "None.";
}

/** The fresh session's preamble: why it's fresh, then the project's state. */
export function leadPreamble(state: LeadState): string {
  const board = clip(state.board.trim(), BOARD_MAX, "… (mission_overview for the rest)");
  return `[This turn starts a fresh session: your last turn ran with about ${Math.round(state.contextTokens / 1000)}k tokens of context, so instead of the whole conversation you get the project's state as it is now. Older messages: chat_read { chatId: "${state.chatId}" }.]
<project_state project="${state.projectName}">
<board>
${board}
</board>
<signals>
${signalsBlock(state.signals, state.now)}
</signals>
<cards>
${cardsBlock(state.cards, state.now)}
</cards>
<knowledge>
${knowledgeBlock(state)}
</knowledge>
<last_messages>
${lastMessages(state.history, state.chatId)}
</last_messages>
</project_state>`;
}

// --- Gathering the state --------------------------------------------------------------------------------------

/** A project's latest signals, newest first (module 12, lane A's store): the unread ones are only counted in the preamble. */
export function recentSignals(projectId: string): LeadSignal[] {
  return leadSignals.list(projectId, SIGNALS_UNREAD + SIGNALS_EARLIER);
}

/** The cards in this Lead's chat still waiting for the user (lead_asks), oldest first, as their first line says them. */
export function openCards(conversationId: string, now = Date.now()): LeadCard[] {
  const rows = db
    .prepare(`SELECT id, message_id, task_id, action, created_at FROM lead_asks WHERE conversation_id = ? AND answered_at IS NULL AND expires_at > ? ORDER BY created_at`)
    .all(conversationId, now) as Row[];
  return rows.map((row) => {
    const part = messages.get(String(row.message_id))?.parts.find((p) => p.id === row.id);
    const asked = part?.type === "approval" ? part.message.split("\n")[0]!.trim() : "";
    const title = taskStore.get(String(row.task_id))?.title ?? "a task";
    return { text: asked || `${row.action === "discard" ? "Discard" : "Land"} “${title}”?`, taskId: String(row.task_id), at: Number(row.created_at) };
  });
}

/** The project's state for a Lead's fresh session. */
export function leadState(lead: Pick<ConversationRecord, "id">, project: Project, history: Message[], contextTokens: number, now = Date.now()): LeadState {
  const brain = brains.get(project.brainId);
  const overview = brain ? wiki.overview(brain.id) : null;
  const memory = settings.get().memory.enabled ? promptMemory(project.id, "").project : null;
  return {
    projectName: project.name,
    chatId: lead.id,
    contextTokens,
    board: projectBoardText(project, lead.id),
    signals: recentSignals(project.id),
    cards: openCards(lead.id, now),
    memory: memory ? { repo: memory.repo, content: memory.content } : null,
    overview: overview ? { summary: overview.summary, content: overview.content } : null,
    history,
    now,
  };
}

export const leadSession = {
  /**
   * For a turn about to start in a chat: when it's a project's Lead whose last turn ran past LEAD_FRESH_TOKENS, the
   * preamble its fresh session starts from and a notice for the user; otherwise (or when the state can't be read)
   * null, and the turn resumes its session as usual.
   */
  freshStart(conversation: Pick<ConversationRecord, "id" | "lead" | "projectId">, history: Message[], now = Date.now()): { preamble: string; notice: string } | null {
    if (!conversation.lead || !conversation.projectId) return null;
    const context = lastTurnContext(history);
    if (context === null || context <= LEAD_FRESH_TOKENS) return null;
    const project = projects.get(conversation.projectId);
    if (!project) return null;
    try {
      const preamble = leadPreamble(leadState(conversation, project, history, context, now));
      return { preamble, notice: `Started a fresh session from the project's state: the conversation had reached about ${Math.round(context / 1000)}k tokens.` };
    } catch (err) {
      console.warn(`[tot] couldn't gather the project's state for the Lead ${conversation.id}; resuming its session:`, err instanceof Error ? err.message : err);
      return null;
    }
  },
};
