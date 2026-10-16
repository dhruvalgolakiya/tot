import { useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import {
  ArrowRight,
  AtSign,
  BellRing,
  BookOpen,
  CalendarClock,
  FileText,
  GitFork,
  Hash,
  ListChecks,
  Monitor,
  Network,
  Pin,
  Puzzle,
  ShieldCheck,
  Smartphone,
  Smile,
  UserRound,
  type LucideIcon,
} from "lucide-react";
import type { MascotState } from "@shared/types";
import { Mascot } from "../../src/components/mascot";
import { crew, type CrewMember } from "../crew";
import { useOs } from "../os/context";
import { createJump, scrollToChild } from "../os/jump";
import { MOCK_TASKS, MockTaskCard } from "./TotApp";

type Feature = { icon: LucideIcon; title: string; joke: string; body: string; visual?: ReactNode };

export const FEATURES: Feature[] = [
  {
    icon: Smile,
    title: "Agents with faces",
    joke: "Yes, the frog wears sunglasses.",
    body: "Each agent has a mascot, a personality and a default model. The mascot shows what it's up to: thinking, working, talking, or napping between routines.",
    visual: <FacesVisual />,
  },
  {
    icon: Monitor,
    title: "A computer of its own",
    joke: "It breaks its own computer, not yours.",
    body: "Every agent gets a computer of its own: a sandboxed folder on your Mac, or a cloud machine with Ubuntu, Docker, Node, Python, Chrome and a real desktop it can click around while you watch. Your own files stay out of it.",
    visual: <TerminalVisual />,
  },
  {
    icon: BookOpen,
    title: "A brain that keeps notes",
    joke: "Remembers your deploy steps, and that you hate long answers.",
    body: "A wiki per agent with a pinned Overview, “Learn a repo”, and a keeper that files quiet chats away. What it learns about you is shared by every agent.",
    visual: <WikiVisual />,
  },
  {
    icon: ListChecks,
    title: "Chats that start tasks",
    joke: "You keep chatting. They keep working.",
    body: "Ask in chat and the agent starts background tasks, each on its own branch and worktree, reporting back as live cards. Steer, pause or queue them.",
    visual: (
      <div className="space-y-2">
        <MockTaskCard task={MOCK_TASKS[0]!} status="done" />
        <MockTaskCard task={MOCK_TASKS[1]!} status="running" />
      </div>
    ),
  },
  {
    icon: Network,
    title: "A team, not a bot",
    joke: "Claude writes it, GPT reviews it, nobody argues. Much.",
    body: "Subagents on either provider, fast, standard and deep model tiers, handoff notes between them, and results gathered back into one answer.",
    visual: <TeamVisual />,
  },
  {
    icon: ShieldCheck,
    title: "Trust gates",
    joke: "Tests first. Opinions second.",
    body: "A profile of each repo, test gates that only block on new failures, scope guards, an independent review by the other provider, and playbooks for how work gets done.",
  },
  {
    icon: BellRing,
    title: "Never left hanging",
    joke: "No more “did it finish?”",
    body: "Chats wake up when their tasks finish, even mid-reply. Restarts, stops and a provider going down are always reported back. Nothing ends silently.",
  },
  {
    icon: GitFork,
    title: "Fork it, bring it back",
    joke: "Side quests without losing the main quest.",
    body: "Fork a chat to chase a wild idea, then bring the findings back to where you started. Attach other chats as context by typing @.",
  },
  {
    icon: Hash,
    title: "Lives in Slack",
    joke: "Coworkers will start @-ing it instead of you.",
    body: "Mention it in a channel and the thread becomes a chat, with a live status line and approve or deny buttons. Results land back in the thread.",
    visual: <SlackVisual />,
  },
  {
    icon: AtSign,
    title: "Its own inbox and GitHub",
    joke: "It has an email address now. It's very proud.",
    body: "Agents sign up, email and commit as themselves. Sending email always asks you first, and emailed tasks only come from senders you allow.",
  },
  {
    icon: CalendarClock,
    title: "Routines",
    joke: "The 9 a.m. brief writes itself.",
    body: "“Every weekday at 9, brief me on AI news.” Ask in chat and it schedules itself; every run starts a fresh chat.",
    visual: <RoutineVisual />,
  },
  {
    icon: Puzzle,
    title: "Apps and plugins",
    joke: "Plays well with your other tools.",
    body: "Any MCP server, the apps connected to your ChatGPT and claude.ai accounts, and apps like Google through Executor, with approval cards.",
  },
  {
    icon: Smartphone,
    title: "In your pocket",
    joke: "Check on the team from the couch.",
    body: "Scan a QR code and your phone is signed in, on your Wi-Fi or from anywhere with Tailscale. This computer never asks for a password. Attachments, light and dark.",
  },
];

/** The features, as a two-pane browser on the desktop and a list of cards on the phone. */
/** Opens What's inside at one feature (from the launcher). */
export const featureJump = createJump();

export function WhatsInside() {
  const { layout } = useOs();
  const [selected, setSelected] = useState(0);
  const [flash, setFlash] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  featureJump.useJump((title) => {
    const index = FEATURES.findIndex((feature) => feature.title === title);
    if (index < 0) return;
    setSelected(index);
    const card = list.current?.querySelector<HTMLElement>(`[data-feature="${index}"]`);
    if (!card) return;
    scrollToChild(card);
    setFlash(title);
    setTimeout(() => setFlash((current) => (current === title ? null : current)), 1600);
  });
  if (layout === "phone") {
    return (
      <div ref={list} className="space-y-3 p-4">
        {FEATURES.map((feature, index) => (
          <div
            key={feature.title}
            data-feature={index}
            className={clsx(
              "rounded-2xl border p-5 transition-colors duration-500",
              flash === feature.title ? "border-accent-edge bg-accent-soft" : "border-hairline bg-fill-subtle",
            )}
          >
            <FeatureDetail feature={feature} />
          </div>
        ))}
      </div>
    );
  }
  const feature = FEATURES[selected]!;
  const next = (selected + 1) % FEATURES.length;
  return (
    <div className="flex h-full">
      <nav aria-label="Features" className="w-56 shrink-0 overflow-y-auto border-r border-hairline p-2">
        <p className="group-label px-2.5 pt-1 pb-2">Shipped · {FEATURES.length}</p>
        {FEATURES.map(({ icon: Icon, title }, index) => (
          <button
            key={title}
            type="button"
            aria-current={index === selected ? "true" : undefined}
            onClick={() => setSelected(index)}
            className={clsx(
              "flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-ui transition-colors",
              index === selected ? "bg-selected text-fg" : "text-fg-muted hover:bg-hover hover:text-fg",
            )}
          >
            <Icon className="size-4 shrink-0" />
            <span className="truncate">{title}</span>
          </button>
        ))}
      </nav>
      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto p-7">
        <FeatureDetail key={feature.title} feature={feature} />
        <button
          type="button"
          onClick={() => setSelected(next)}
          className="mt-auto flex items-center gap-1.5 self-end pt-6 text-ui text-fg-muted transition-colors hover:text-fg"
        >
          Next: {FEATURES[next]!.title} <ArrowRight className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

function FeatureDetail({ feature }: { feature: Feature }) {
  const Icon = feature.icon;
  return (
    <div className="animate-fade-in">
      <span className="mb-4 grid size-10 place-items-center rounded-xl bg-fill text-fg">
        <Icon className="size-5" />
      </span>
      <h2 className="font-display text-3xl font-semibold tracking-tight text-fg-strong">{feature.title}</h2>
      <p className="mt-1.5 text-lg text-fg">{feature.joke}</p>
      <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-fg-muted">{feature.body}</p>
      {feature.visual && <div className="mt-6 max-w-xl">{feature.visual}</div>}
    </div>
  );
}

function FacesVisual() {
  const faces: { who: CrewMember; state: MascotState }[] = [
    { who: "ribbit", state: "idle" },
    { who: "mochi", state: "thinking" },
    { who: "bolt", state: "working" },
    { who: "rosy", state: "speaking" },
    { who: "nimbus", state: "sleeping" },
  ];
  return (
    <div aria-hidden="true" className="flex items-end justify-between rounded-xl bg-fill-subtle px-4 pt-4 pb-2">
      {faces.map(({ who, state }) => (
        <Mascot key={who} spec={crew[who].spec} state={state} size={52} />
      ))}
    </div>
  );
}

function TerminalVisual() {
  const lines: { text: string; tone: "prompt" | "ok" | "muted" | "plain" }[] = [
    { text: "tot@tots-computer:~/repos/shop$ npm test", tone: "prompt" },
    { text: " PASS  cart.spec.ts · 214 tests", tone: "ok" },
    { text: "tot@tots-computer:~/repos/shop$ npm run dev", tone: "prompt" },
    { text: " ready on :3000 → shared as a public link", tone: "plain" },
    { text: "[desktop] opened Chrome · clicked “Sign up”", tone: "muted" },
    { text: "[desktop] typed the agent's own email address", tone: "muted" },
  ];
  return (
    <div aria-hidden="true" className="dark overflow-hidden rounded-xl border border-hairline bg-panel">
      <div className="space-y-1 overflow-hidden p-4 font-mono text-xs leading-relaxed">
        {lines.map((line) => (
          <p
            key={line.text}
            className={clsx(
              "truncate",
              line.tone === "prompt" && "text-fg",
              line.tone === "ok" && "text-success",
              line.tone === "muted" && "text-fg-subtle",
              line.tone === "plain" && "text-fg-muted",
            )}
          >
            {line.text}
          </p>
        ))}
      </div>
    </div>
  );
}

function WikiVisual() {
  const pages: { icon: LucideIcon; title: string; note: string }[] = [
    { icon: Pin, title: "Overview", note: "pinned in every chat" },
    { icon: FileText, title: "Repo profile · shop", note: "commands, protected paths" },
    { icon: FileText, title: "How we deploy", note: "from Tuesday's chat" },
    { icon: UserRound, title: "About you", note: "likes tables, hates long answers" },
  ];
  return (
    <div aria-hidden="true" className="overflow-hidden rounded-xl border border-hairline p-1.5">
      {pages.map(({ icon: Icon, title, note }, index) => (
        <div key={title} className={clsx("flex h-10 items-center gap-2.5 rounded-lg px-3", index === 0 && "bg-selected")}>
          <Icon className="size-4 shrink-0 text-fg-subtle" />
          <span className="min-w-0 flex-1 truncate text-ui text-fg">{title}</span>
          <span className="truncate text-xs text-fg-subtle">{note}</span>
        </div>
      ))}
    </div>
  );
}

function TeamVisual() {
  const steps: { who: CrewMember; role: string; on: string }[] = [
    { who: "mochi", role: "Planner", on: "Claude · deep" },
    { who: "tot", role: "Implementer", on: "Claude · deep" },
    { who: "perry", role: "Reviewer", on: "ChatGPT · standard" },
  ];
  return (
    <div aria-hidden="true" className="flex items-center gap-2 rounded-xl bg-fill-subtle p-4">
      {steps.map((step, index) => (
        <div key={step.who} className="flex flex-1 items-center gap-2">
          <div className="flex flex-1 flex-col items-center gap-1 text-center">
            <Mascot spec={crew[step.who].spec} state={index === 1 ? "working" : "idle"} size={44} />
            <p className="text-ui font-medium text-fg">{step.role}</p>
            <p className="text-xs text-fg-subtle">{step.on}</p>
          </div>
          {index < steps.length - 1 && <ArrowRight className="size-4 shrink-0 text-fg-faint" />}
        </div>
      ))}
    </div>
  );
}

function SlackVisual() {
  return (
    <div aria-hidden="true" className="overflow-hidden rounded-xl border border-hairline">
      <p className="border-b border-hairline px-4 py-2 text-ui font-medium text-fg">
        <span className="text-fg-subtle">#</span> bugs
      </p>
      <div className="space-y-3 p-4">
        <div className="flex gap-2.5">
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-fill text-ui font-semibold text-fg-muted">S</span>
          <p className="text-ui text-fg">
            <span className="font-semibold">Sam</span> <span className="text-fg-subtle">10:24</span>
            <br />
            <span className="font-medium text-accent-text">@Tot</span> checkout is flaky again. Third time this week.
          </p>
        </div>
        <div className="flex gap-2.5">
          <span className="grid size-8 shrink-0 place-items-center">
            <Mascot spec={crew.tot.spec} state="working" size={30} />
          </span>
          <div className="min-w-0 text-ui text-fg">
            <p>
              <span className="font-semibold">Tot</span> <span className="text-fg-subtle">10:24</span>
            </p>
            <p className="text-fg-muted">Working on it · 2 tasks running · 1m 40s</p>
            <div className="mt-2 flex gap-1.5">
              <span className="rounded-md border border-edge px-2.5 py-1 text-xs font-medium text-fg">Approve npm install</span>
              <span className="rounded-md border border-edge px-2.5 py-1 text-xs text-fg-muted">Deny</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function RoutineVisual() {
  return (
    <div aria-hidden="true" className="flex items-center gap-3 rounded-xl border border-hairline p-4">
      <Mascot spec={crew.nova.spec} state="speaking" size={40} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-fg">AI news brief</p>
        <p className="text-xs text-fg-subtle">Weekdays at 9:00 · next run tomorrow · Nova</p>
      </div>
      <span className="rounded-full bg-success-soft px-2 py-0.5 text-2xs font-medium text-success">On</span>
    </div>
  );
}
