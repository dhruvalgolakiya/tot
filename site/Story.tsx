import { Ban, type LucideIcon, GitMerge, GitBranch, KeyRound, Laptop, MailX, UserX } from "lucide-react";
import type { MascotState } from "@shared/types";
import { Mascot } from "../src/components/mascot";
import { crew, type CrewMember } from "./crew";
import { Heading, Reveal, Section } from "./ui";

const DAY: { time: string; who: CrewMember; state: MascotState; text: string }[] = [
  { time: "9:00", who: "nova", state: "speaking", text: "Your weekday AI brief arrives. Three bullets. One of them actually matters." },
  {
    time: "10:24",
    who: "tot",
    state: "thinking",
    text: "Someone @-mentions Tot in #bugs. The thread becomes a chat, and Tot reproduces the bug on its own computer.",
  },
  {
    time: "10:31",
    who: "tot",
    state: "working",
    text: "It starts a fix task on its own branch, and keeps answering questions in the thread while it works.",
  },
  {
    time: "11:02",
    who: "perry",
    state: "thinking",
    text: "A reviewer on the other provider reads the fix and catches an off-by-one. Fixed before you ever saw it.",
  },
  { time: "11:05", who: "tot", state: "happy", text: "The chat wakes up with the result and posts it to the Slack thread. Once. Not four times." },
  { time: "14:30", who: "mochi", state: "speaking", text: "You fork the launch-plan chat to try a wilder idea, then bring the good bits back." },
  {
    time: "23:40",
    who: "bolt",
    state: "working",
    text: "Claude hits its usage limit halfway through the queue. ChatGPT picks up the rest. Nobody pages you.",
  },
  {
    time: "8:00",
    who: "ribbit",
    state: "sleeping",
    text: "Morning. Everything's in a tidy report, and a branch is waiting for your review. Ribbit is still asleep. Let it be.",
  },
];

export function Day() {
  return (
    <Section id="day">
      <Heading
        eyebrow="A day with your team"
        title="You have meetings. They have it handled."
        intro="Here's what a normal Tuesday looks like when the team runs on TOT."
      />
      <ol className="relative mx-auto max-w-3xl">
        <span aria-hidden="true" className="absolute top-2 bottom-2 left-[5.375rem] w-px bg-hairline sm:left-[6.875rem]" />
        {DAY.map((entry, index) => (
          <li key={`${entry.time}-${index}`}>
            <Reveal delay={60} className="relative flex items-start gap-4 py-4 sm:gap-6">
              <span className="w-12 shrink-0 pt-3 text-right font-mono text-ui text-fg-subtle tabular-nums sm:w-16">{entry.time}</span>
              <span className="relative z-10 grid size-11 shrink-0 place-items-center rounded-full border border-hairline bg-canvas">
                <Mascot spec={crew[entry.who].spec} state={entry.state} size={34} />
              </span>
              <p className="min-w-0 flex-1 pt-2.5 text-base leading-relaxed text-fg">
                <span className="font-semibold text-fg-strong">{crew[entry.who].name}. </span>
                {entry.text}
              </p>
            </Reveal>
          </li>
        ))}
      </ol>
    </Section>
  );
}

const NEVER: { icon: LucideIcon; title: string; body: string }[] = [
  { icon: GitMerge, title: "Merge your pull request", body: "Merging is your call, every time. Agents can open a PR when you ask; that's where they stop." },
  { icon: GitBranch, title: "Push to main", body: "Agents push only their own branches, and only once you've switched GitHub writes on." },
  { icon: MailX, title: "Email anyone without asking", body: "Every outgoing email waits for your OK. Emailed tasks only come from senders you allow." },
  { icon: Laptop, title: "Touch your files", body: "Agents work on their own computers, or a sandboxed folder. Your Mac's files stay yours." },
  { icon: UserX, title: "Talk to strangers", body: "Off this machine, TOT needs a sign-in token. Wrong guesses are rate-limited." },
  { icon: KeyRound, title: "Blab your secrets", body: "Tokens are scrubbed from tool output, logs and errors before anyone sees them." },
];

export function Never() {
  return (
    <Section id="safety" className="border-y border-hairline bg-panel">
      <Heading
        eyebrow="Safe by default"
        title="Things TOT will never do."
        intro="Leave it running overnight. It's polite, it asks first, and it knows where the line is."
      />
      <div className="grid gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
        {NEVER.map(({ icon: Icon, title, body }, index) => (
          <Reveal key={title} delay={(index % 3) * 70} className="flex gap-4">
            <span className="relative grid size-10 shrink-0 place-items-center rounded-full bg-danger-soft text-danger">
              <Icon className="size-4.5" />
              <Ban aria-hidden="true" className="absolute -right-1 -bottom-1 size-4 rounded-full bg-panel text-danger" />
            </span>
            <div>
              <h3 className="text-base font-semibold text-fg-strong">{title}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">{body}</p>
            </div>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}
