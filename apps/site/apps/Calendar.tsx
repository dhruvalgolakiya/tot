import type { MascotState } from "@shared/types";
import { Mascot } from "../../src/components/mascot";
import { crew, type CrewMember } from "../crew";

const DAY: { time: string; who: CrewMember; state: MascotState; title: string; text: string }[] = [
  { time: "9:00", who: "nova", state: "speaking", title: "AI brief (routine)", text: "Three bullets. One of them actually matters." },
  {
    time: "10:24",
    who: "tot",
    state: "thinking",
    title: "Bug in #bugs",
    text: "Someone @-mentions Tot. The thread becomes a chat; Tot reproduces the bug on its own computer.",
  },
  {
    time: "10:31",
    who: "tot",
    state: "working",
    title: "Fix task, own branch",
    text: "Keeps answering questions in the thread while it works.",
  },
  {
    time: "11:02",
    who: "perry",
    state: "thinking",
    title: "Review, other provider",
    text: "Catches an off-by-one. Fixed before you ever saw it.",
  },
  {
    time: "11:05",
    who: "tot",
    state: "happy",
    title: "Back to the thread",
    text: "The chat wakes up and posts the result in Slack. Once. Not four times.",
  },
  {
    time: "14:30",
    who: "mochi",
    state: "speaking",
    title: "Fork the launch plan",
    text: "Tries a wilder idea in a fork, then brings the good bits back.",
  },
  {
    time: "23:40",
    who: "bolt",
    state: "working",
    title: "Claude hits its limit",
    text: "ChatGPT picks up the rest of the queue. Nobody pages you.",
  },
  {
    time: "8:00",
    who: "ribbit",
    state: "sleeping",
    title: "Morning report",
    text: "Everything's summed up, and a branch waits for your review. Ribbit is still asleep. Let it be.",
  },
];

/** A day with the team, as a calendar. */
export function Calendar() {
  return (
    <div className="px-5 py-5 sm:px-6">
      <div className="mb-5 flex items-baseline justify-between gap-4">
        <h2 className="font-display text-3xl font-semibold tracking-tight text-fg-strong">Tuesday</h2>
        <span className="text-sm text-fg-subtle">A normal day with your team</span>
      </div>
      <ol className="space-y-2">
        {DAY.map((entry, index) => (
          <li key={`${entry.time}-${index}`} className="flex gap-3">
            <span className="w-11 shrink-0 pt-3 text-right font-mono text-xs text-fg-subtle tabular-nums">{entry.time}</span>
            <div className="flex min-w-0 flex-1 gap-3 rounded-xl border border-hairline p-3">
              <Mascot spec={crew[entry.who].spec} state={entry.state} size={34} />
              <div className="min-w-0">
                <p className="text-sm font-medium text-fg">
                  {entry.title} <span className="font-normal text-fg-subtle">· {crew[entry.who].name}</span>
                </p>
                <p className="mt-0.5 text-ui leading-relaxed text-fg-muted">{entry.text}</p>
              </div>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
