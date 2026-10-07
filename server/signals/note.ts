import type { LeadSignal } from "../../shared/types.ts";

/**
 * Module 12 (docs/roadmap/12-coordinator.md), lane A: how a project's Lead hears its signals. A wake's own message
 * (the quiet divider: "Checks failed on draft PR #12 “Fix cart”.") and the note its turn gets with every unread
 * signal, as task results are told (server/tasks/prompt.ts). What to do with each kind is in the Lead's prompt.
 */

const sentence = (title: string) => (/[.!?…]$/.test(title) ? title : `${title}.`);

/** The wake's message for these signals: one says itself, several are counted and the first named. */
export function signalsText(signals: Pick<LeadSignal, "title">[]): string {
  if (!signals.length) return "";
  if (signals.length === 1) return sentence(signals[0]!.title);
  const shown = signals.slice(0, 2).map((signal) => signal.title.replace(/[.!?]$/, ""));
  const more = signals.length - shown.length;
  return `${signals.length} updates: ${shown.join("; ")}${more ? `; and ${more} more` : ""}.`;
}

/** Unread signals as a note for the Lead's turn; "" when there are none. */
export function signalsNote(signals: LeadSignal[]): string {
  if (!signals.length) return "";
  const blocks = signals.map((signal) =>
    JSON.stringify(
      {
        kind: signal.kind,
        title: signal.title,
        ...(signal.detail ? { detail: signal.detail } : {}),
        ...(signal.repoName ? { repo: signal.repoName } : {}),
        ...(signal.prNumber !== null ? { pr: signal.prNumber } : {}),
        ...(signal.taskId ? { task_id: signal.taskId } : {}),
        ...(signal.url ? { url: signal.url } : {}),
        at: new Date(signal.at).toISOString(),
      },
      null,
      1,
    ),
  );
  return `[Signals for this project that you haven't heard yet (pull requests, tickets, schedules):
<signals>
${blocks.join("\n")}
</signals>
Act on them where it helps: start, steer, stop, pause or resume tasks, and tell the user in a few lines. Nothing goes to GitHub, Slack or Linear on its own; pushing and landing go through your cards. The user sees each one as a note in this chat.]`;
}
