import type { ReactNode } from "react";
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
import { Mascot } from "../src/components/mascot";
import { crew, type CrewMember } from "./crew";
import { Heading, Reveal, Section } from "./ui";

/** How TOT Auto picks a model, as a few "you say → it picks" rows. */
export function Brains() {
  const routes: { ask: string; pick: string; note: string }[] = [
    { ask: "What's 15% of 84?", pick: "Sonnet 5.5", note: "fast" },
    { ask: "Why does checkout crash on Safari?", pick: "Opus 5.5 or GPT‑6", note: "deep" },
    { ask: "Think harder: redesign the billing schema", pick: "The strongest model", note: "extra effort" },
    { ask: "Claude just hit its usage limit", pick: "ChatGPT takes the shift", note: "until it resets" },
    { ask: "Someone should check this diff", pick: "The other provider", note: "fresh eyes" },
  ];
  return (
    <Section id="brains" className="border-y border-hairline bg-panel">
      <div className="grid items-center gap-12 lg:grid-cols-[1fr_1.15fr]">
        <Reveal>
          <p className="mb-3 text-ui font-medium text-fg-subtle">Two brains, zero API keys</p>
          <h2 className="font-display text-4xl font-semibold tracking-tight text-balance text-fg-strong sm:text-5xl">
            Runs on the plans you already pay for.
          </h2>
          <p className="mt-4 text-lg leading-relaxed text-pretty text-fg-muted">
            Claude through Claude Code, ChatGPT through Codex, both with your own login. TOT picks the right model for each job, and when
            one brain runs out of juice, the other one takes the next shift.
          </p>
        </Reveal>
        <Reveal delay={120} className="min-w-0">
          <div className="surface-raised overflow-hidden rounded-2xl border border-edge">
            <div className="grid grid-cols-[1fr_auto] gap-4 border-b border-hairline px-5 py-3 text-xs text-fg-subtle">
              <span>You say</span>
              <span>TOT picks</span>
            </div>
            {routes.map((route) => (
              <div key={route.ask} className="flex items-center gap-3 border-b border-hairline px-5 py-3.5 last:border-b-0">
                <p className="min-w-0 flex-1 text-sm text-fg">“{route.ask}”</p>
                <ArrowRight className="size-4 shrink-0 text-fg-faint" />
                <p className="w-36 shrink-0 text-right text-sm sm:w-48">
                  <span className="block font-medium text-fg">{route.pick}</span>
                  <span className="block text-xs text-fg-subtle">{route.note}</span>
                </p>
              </div>
            ))}
          </div>
        </Reveal>
      </div>
    </Section>
  );
}

type Feature = {
  icon: LucideIcon;
  title: string;
  joke: string;
  body: string;
  wide?: boolean;
  visual?: ReactNode;
};

const FEATURES: Feature[] = [
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
    body: "Every agent gets a cloud machine with Ubuntu, Docker, Node, Python, Chrome and a real desktop it can click around while you watch. Servers it starts can be shared as links. Your Mac stays out of it.",
    wide: true,
    visual: <TerminalVisual />,
  },
  {
    icon: BookOpen,
    title: "A brain that keeps notes",
    joke: "Remembers your deploy steps, and that you hate long answers.",
    body: "A wiki per agent with a pinned Overview, “Learn a repo”, and a keeper that files quiet chats away. What it learns about you is shared by every agent.",
    wide: true,
    visual: <WikiVisual />,
  },
  {
    icon: ListChecks,
    title: "Chats that start tasks",
    joke: "You keep chatting. They keep working.",
    body: "Ask in chat and the agent starts background tasks, each on its own branch and worktree, reporting back as live cards. Steer, pause or queue them.",
  },
  {
    icon: Network,
    title: "A team, not a bot",
    joke: "Claude writes it, GPT reviews it, nobody argues. Much.",
    body: "Subagents on either provider, fast, standard and deep model tiers, handoff notes between them, and results gathered back into one answer.",
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
    body: "Open it on your phone over Wi-Fi with a sign-in token, or from anywhere through a tunnel. Voice input, attachments, light and dark.",
  },
];

export function Features() {
  return (
    <Section id="features">
      <Heading
        eyebrow="What's inside"
        title="Everything a tiny team needs."
        intro="Shipped and working today. Each agent is a coworker with a desk, a notebook and a very specific hat."
      />
      <div className="grid gap-4 md:grid-cols-3">
        {FEATURES.map((feature, index) => (
          <Reveal key={feature.title} delay={(index % 3) * 70} className={clsx("min-w-0", feature.wide && "md:col-span-2")}>
            <FeatureCard feature={feature} />
          </Reveal>
        ))}
      </div>
    </Section>
  );
}

function FeatureCard({ feature }: { feature: Feature }) {
  const Icon = feature.icon;
  return (
    <article
      className={clsx(
        "flex h-full flex-col gap-5 rounded-2xl border border-hairline bg-fill-subtle p-6 transition-colors hover:border-edge",
        feature.wide && "lg:flex-row lg:items-center",
      )}
    >
      <div className={clsx("flex flex-col", feature.wide && "lg:w-[42%] lg:shrink-0")}>
        <span className="mb-4 grid size-9 place-items-center rounded-xl bg-fill text-fg">
          <Icon className="size-4.5" />
        </span>
        <h3 className="text-lg font-semibold tracking-tight text-fg-strong">{feature.title}</h3>
        <p className="mt-1 text-sm font-medium text-fg">{feature.joke}</p>
        <p className="mt-3 text-sm leading-relaxed text-fg-muted">{feature.body}</p>
      </div>
      {feature.visual && <div className={clsx("min-w-0", feature.wide ? "lg:flex-1" : "mt-auto")}>{feature.visual}</div>}
    </article>
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
    <div aria-hidden="true" className="flex items-end justify-between rounded-xl bg-fill-subtle px-3 pt-4 pb-2">
      {faces.map(({ who, state }) => (
        <Mascot key={who} spec={crew[who].spec} state={state} size={48} />
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
      <div className="flex h-8 items-center gap-1.5 border-b border-hairline px-3">
        <span className="size-2 rounded-full bg-fill-strong" />
        <span className="size-2 rounded-full bg-fill-strong" />
        <span className="size-2 rounded-full bg-fill-strong" />
        <span className="ml-2 text-2xs text-fg-subtle">Tot's computer · Ubuntu</span>
      </div>
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
        <p className="text-fg">
          tot@tots-computer:~$ <span className="inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse bg-fg-muted" />
        </p>
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
    <div aria-hidden="true" className="overflow-hidden rounded-xl border border-hairline bg-canvas p-1.5">
      {pages.map(({ icon: Icon, title, note }, index) => (
        <div key={title} className={clsx("flex h-10 items-center gap-2.5 rounded-lg px-3", index === 0 && "bg-selected")}>
          <Icon className="size-4 shrink-0 text-fg-subtle" />
          <span className="min-w-0 flex-1 truncate text-ui text-fg">{title}</span>
          <span className="hidden truncate text-xs text-fg-subtle sm:block">{note}</span>
        </div>
      ))}
    </div>
  );
}
