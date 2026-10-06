import { create } from "zustand";
import type { MemoryCommit } from "@shared/types";

/**
 * Memory repo (roadmap module 10) on the client: which repo Settings → Memory shows ("you", or
 * "projects/<slug>", picked from a project's page too), and a counter per repo that `memory` app events
 * bump, so open views reload when memory changes (an agent remembered something, a sync, a dream).
 */

interface MemoryUiState {
  repo: string;
  versions: Record<string, number>;
}

export const useMemoryUi = create<MemoryUiState>()(() => ({ repo: "you", versions: {} }));

export const projectMemoryRepo = (slug: string) => `projects/${slug}`;

export function pickMemoryRepo(repo: string) {
  useMemoryUi.setState({ repo });
}

/** A `memory` event: that repo changed. */
export function memoryChanged(repo: string) {
  useMemoryUi.setState((s) => ({ versions: { ...s.versions, [repo]: (s.versions[repo] ?? 0) + 1 } }));
}

const VERBS: Record<string, string> = { remember: "Remembered", edit: "Edited", forget: "Forgot" };

/** "remember “Prefers pnpm”" → "Remembered “Prefers pnpm”"; anything else just capitalized. */
function describeAction(action: string): string {
  const [verb, ...words] = action.split(" ");
  if (verb && VERBS[verb] && words.length) {
    const text = words.join(" ");
    return `${VERBS[verb]} ${text === "(text hidden)" ? text : `“${text.replace(/^“|”$/g, "")}”`}`;
  }
  return action.charAt(0).toUpperCase() + action.slice(1);
}

/**
 * A commit as a line for the history: "Remembered “Prefers pnpm”", "Merged 3, removed 2", "Undid: Forgot “…”",
 * "Synced with MacBook Air".
 */
export function describeCommit(commit: MemoryCommit): string {
  const rest = commit.subject.replace(/^[^:]{1,40}: /, "");
  if (commit.kind === "sync" || commit.kind === "backup") return describeAction(rest.replace(/^merged from /i, "synced with "));
  if (commit.kind === "undo" && rest.startsWith("undo ")) {
    // The undone commit's own subject, in quotes: "you: undo “Kiwi: remember …”".
    const inner = rest.slice("undo ".length).replace(/^“|”$/g, "").replace(/^[^:]{1,40}: /, "");
    return `Undid: ${describeAction(inner)}`;
  }
  return describeAction(rest);
}

/** Who made a commit, for the history. */
export const commitActor = (commit: MemoryCommit) => (commit.actor === "you" ? "You" : commit.actor);

/** MEMORY.md's prose without its entries (they're listed below it), its first heading, or entry metadata. */
export function memoryProse(content: string): string {
  const out: string[] = [];
  let fence = false;
  let headingDropped = false;
  for (const line of content.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (!fence && /^\s*[-*]\s+\S/.test(line)) continue;
    if (!fence && !headingDropped && /^#\s/.test(line)) {
      headingDropped = true;
      continue;
    }
    out.push(line);
  }
  return out
    .join("\n")
    .replace(/\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g, "`$1`")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
