import type { MemoryCommit } from "@tot/shared/types";

/** Memory history lines, ported from apps/web/src/lib/memory.ts so a change reads the same on the phone. */

const VERBS: Record<string, string> = { remember: "Remembered", edit: "Edited", forget: "Forgot" };
/** Module 11: a project's wiki pages commit to its repo too ("Kiwi: edit page “Checkout flow”"). */
const PAGE_VERBS: Record<string, string> = { write: "Wrote", edit: "Edited", move: "Moved", delete: "Deleted", restore: "Restored", import: "Imported" };

/** "remember “Prefers pnpm”" → "Remembered “Prefers pnpm”", "edit page “Cart”" → "Edited page “Cart”"; anything else just capitalized. */
function describeAction(action: string): string {
  const page = /^(\w+) page (“.*)$/.exec(action);
  if (page && PAGE_VERBS[page[1]]) return `${PAGE_VERBS[page[1]]} page ${page[2].endsWith("”") ? page[2] : `${page[2]}”`}`;
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
