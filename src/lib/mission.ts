import type { ProviderId, ProviderStatus, TaskChecks, TaskDiffStats, TaskLanding } from "@shared/types";
import { toMs } from "./format";
import { PROVIDER_LABELS } from "./models";
import type { TaskConversation } from "./tasks";

/**
 * Mission control (roadmap module 09, lane B): how the board sorts tasks into sections and words
 * their stats, checks and landing, and the composer's one slash command, /best-of.
 */

export type MissionSection = "needs-you" | "working" | "ready" | "landed";

export const SECTION_TITLES: Record<MissionSection, string> = {
  "needs-you": "Needs you",
  working: "Working",
  ready: "Ready to land",
  landed: "Landed",
};

/** Where a task sits on the board: waiting on the user, working, finished with code to land, or landed (or finished without code). */
export function missionSection(task: TaskConversation): MissionSection {
  const { status, landing, repo } = task.task;
  if (landing) return "landed";
  if (status === "needs-input" || status === "failed" || status === "interrupted") return "needs-you";
  if (status === "running" || status === "queued" || status === "paused") return "working";
  return repo?.headSha ? "ready" : "landed";
}

/** The board's sections in order, each sorted: working ones running first, ready ones in land order, landed ones newest first. */
export function boardSections(tasks: TaskConversation[], landOrder: string[]): Record<MissionSection, TaskConversation[]> {
  const sections: Record<MissionSection, TaskConversation[]> = { "needs-you": [], working: [], ready: [], landed: [] };
  for (const task of tasks) sections[missionSection(task)].push(task);
  const newest = (a: TaskConversation, b: TaskConversation) => toMs(b.updatedAt) - toMs(a.updatedAt);
  const rank: Record<string, number> = { running: 0, queued: 1, paused: 2 };
  sections["needs-you"].sort(newest);
  sections.working.sort(
    (a, b) => (rank[a.task.status] ?? 3) - (rank[b.task.status] ?? 3) || (a.task.queuePosition ?? 0) - (b.task.queuePosition ?? 0) || newest(a, b),
  );
  const place = (id: string) => (landOrder.includes(id) ? landOrder.indexOf(id) : landOrder.length);
  sections.ready.sort((a, b) => place(a.id) - place(b.id) || newest(a, b));
  const ended = (task: TaskConversation) => toMs(task.task.landing?.at ?? task.task.finishedAt ?? task.updatedAt);
  sections.landed.sort((a, b) => ended(b) - ended(a));
  return sections;
}

/** "+42 −7 · 3 files". */
export function statsLine(stats: TaskDiffStats): string {
  return `+${stats.added} −${stats.removed} · ${stats.files} file${stats.files === 1 ? "" : "s"}`;
}

/** "Merged into main · abc1234", "Draft PR against main", "Discarded". */
export function landingLine(landing: TaskLanding): string {
  if (landing.kind === "merged") return `Merged into ${landing.target ?? "main"}${landing.sha ? ` · ${landing.sha.slice(0, 7)}` : ""}`;
  if (landing.kind === "pr") return `Draft PR against ${landing.target ?? "main"}`;
  return "Discarded";
}

/** What a task is doing, or what it needs, in one line (mission control's cards and Home). */
export function taskStatusLine(task: TaskConversation): string {
  const info = task.task;
  if (info.landing) return landingLine(info.landing);
  const firstLine = (text: string | null | undefined) => text?.split("\n").find((line) => line.trim())?.trim() ?? null;
  switch (info.status) {
    case "needs-input":
      return info.question ?? "Waiting for your OK";
    case "queued":
      return info.queuePosition ? `Waiting in line · #${info.queuePosition}` : "Waiting in line";
    case "interrupted":
      return "Cut off by a restart · resume it to carry on";
    case "paused":
      return info.progress ?? "Paused";
    case "running":
      return info.progress ?? info.goal;
    default:
      return firstLine(info.result?.summary) ?? firstLine(info.summary) ?? info.goal;
  }
}

export const CHECKS_LABELS: Record<TaskChecks["state"], string> = {
  running: "Checks running",
  passing: "Checks passing",
  failing: "Checks failing",
  none: "No checks",
};

/** The providers a best-of run uses: both when both are signed in, else the one twice. */
export function bestOfProviders(providers: ProviderStatus[]): ProviderId[] {
  const up = (["claude", "chatgpt"] as const).filter((id) => providers.find((p) => p.id === id)?.loggedIn);
  return up.length === 1 ? [up[0]!, up[0]!] : [...up];
}

/** "Claude and ChatGPT", "Claude twice". */
export function bestOfLabel(providers: ProviderId[]): string {
  if (providers.length === 2 && providers[0] === providers[1]) return `${PROVIDER_LABELS[providers[0]!]} twice`;
  return providers.map((id) => PROVIDER_LABELS[id]).join(" and ");
}

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

export type SlashCommandName = "best-of";

export const SLASH_COMMANDS: { name: SlashCommandName; description: string }[] = [
  { name: "best-of", description: "On Claude and ChatGPT, then compare" },
];

/** While the command itself is being typed ("/", "/be"): what's typed after the slash; null otherwise. */
export function slashQuery(text: string): string | null {
  const match = /^\/([\w-]*)$/.exec(text);
  return match ? match[1]!.toLowerCase() : null;
}

/** "/best-of fix the cart total" → { command: "best-of", body: "fix the cart total" }; null for anything else. */
export function parseSlash(text: string): { command: SlashCommandName; body: string } | null {
  const match = /^\/(best-of)(?:\s+([\s\S]*))?$/.exec(text.trimStart());
  return match ? { command: match[1] as SlashCommandName, body: (match[2] ?? "").trim() } : null;
}

/** A request id for one click of Send, so a double click or a retried request starts the task only once. */
export function newRequestId(): string {
  // randomUUID only exists on secure origins; a phone on the LAN may reach TOT over plain http.
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
