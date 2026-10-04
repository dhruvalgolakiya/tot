import { useState } from "react";
import clsx from "clsx";
import { Check, Copy, Plus } from "lucide-react";
import { Badge, type BadgeTone } from "../src/components/ui/Badge";
import { Heading, Reveal, Section } from "./ui";

type Column = { label: string; tone: BadgeTone; note: string; items: { title: string; body?: string }[] };

const COLUMNS: Column[] = [
  {
    label: "Shipped",
    tone: "success",
    note: "Working today",
    items: [
      { title: "Agents, mascots and personalities" },
      { title: "A computer per agent, with a live desktop" },
      { title: "Brains: wiki, memory and Learn a repo" },
      { title: "Routines, attachments, voice and phone access" },
      { title: "Slack, email and agent personas" },
      { title: "Apps, MCP plugins and connectors" },
      { title: "Chats and tasks: branches, queue, steer, pause" },
      { title: "Orchestration: tiers, subagents, handoffs, failover" },
      { title: "Trust gates: repo profiles, tests, cross-provider review" },
      { title: "Coordination: wake-ups, forks, attached chats" },
    ],
  },
  {
    label: "Next",
    tone: "warning",
    note: "Being built",
    items: [
      {
        title: "Playbooks drive every task",
        body: "Plan, build, test and an independent review, step by step, before you see a thing.",
      },
      {
        title: "Pull requests without leaving TOT",
        body: "View the diff, open a draft PR with the evidence, watch CI checks, fix review comments and update the branch. Merging stays with you.",
      },
      {
        title: "Shortcuts for all of it",
        body: "Keyboard shortcuts for the PR flow, and an optional “fix failing checks once” for when CI turns red.",
      },
    ],
  },
  {
    label: "Later",
    tone: "neutral",
    note: "On the whiteboard",
    items: [
      {
        title: "Projects",
        body: "Agent, then project, then session. A repo's brain, instructions and default branch, shared by every agent that works on it.",
      },
      {
        title: "TOT for everyone",
        body: "A hosted TOT where people bring their own API keys or sign in with ChatGPT, each agent still on its own isolated computer.",
      },
    ],
  },
];

export function Roadmap() {
  return (
    <Section id="roadmap">
      <Heading eyebrow="Roadmap" title="What's shipped, and what's next." intro="TOT grows a module at a time. Here's where it is." />
      <div className="grid gap-4 lg:grid-cols-3">
        {COLUMNS.map((column, index) => (
          <Reveal key={column.label} delay={index * 90} className="h-full">
            <div className="flex h-full flex-col rounded-2xl border border-hairline p-5">
              <div className="mb-4 flex items-center gap-2">
                <Badge tone={column.tone} dot>
                  {column.label}
                </Badge>
                <span className="text-xs text-fg-subtle">{column.note}</span>
              </div>
              <ul className={clsx(column.items.some((item) => item.body) ? "space-y-4" : "space-y-2.5")}>
                {column.items.map((item) => (
                  <li key={item.title} className="flex gap-2.5">
                    {column.tone === "success" ? (
                      <Check className="mt-0.5 size-4 shrink-0 text-success" />
                    ) : (
                      <span className="mt-2 size-1.5 shrink-0 rounded-full bg-fg-faint" />
                    )}
                    <div>
                      <p className={clsx("text-sm", item.body ? "font-medium text-fg" : "text-fg-muted")}>{item.title}</p>
                      {item.body && <p className="mt-1 text-sm leading-relaxed text-fg-muted">{item.body}</p>}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}

const SETUP = `# 1. Log in once, to either or both
claude          # then type /login
codex login

# 2. Start TOT
npm install
npm run dev

# 3. Say hi to Tot
open http://localhost:5173`;

export function QuickStart() {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(SETUP);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // No clipboard access (e.g. plain http on another device): the text is still selectable.
    }
  }
  return (
    <Section id="start" className="border-y border-hairline bg-panel">
      <div className="grid items-center gap-12 lg:grid-cols-2">
        <div>
          <Heading
            eyebrow="Get started"
            title="Up and running in two minutes."
            intro="You need Node 22.13 or newer, and a Claude or ChatGPT login on this Mac. That's it."
          />
          <Reveal>
            <ul className="space-y-3 text-sm leading-relaxed text-fg-muted">
              <li className="flex gap-2.5">
                <Plus className="mt-0.5 size-4 shrink-0 text-fg-subtle" />
                <span>
                  <span className="font-medium text-fg">Cloud computers are optional.</span> Add a boat.dev key and every agent gets its own
                  VM with a desktop. Without one, each agent works in a sandboxed folder.
                </span>
              </li>
              <li className="flex gap-2.5">
                <Plus className="mt-0.5 size-4 shrink-0 text-fg-subtle" />
                <span>
                  <span className="font-medium text-fg">Want it on your phone?</span> Set an access token and it opens on your Wi-Fi, or
                  anywhere through an HTTPS tunnel.
                </span>
              </li>
            </ul>
          </Reveal>
        </div>
        <Reveal delay={120} className="min-w-0">
          <div className="dark overflow-hidden rounded-2xl border border-hairline bg-canvas shadow-dialog">
            <div className="flex h-10 items-center gap-1.5 border-b border-hairline px-4">
              <span className="size-2.5 rounded-full bg-fill-strong" />
              <span className="size-2.5 rounded-full bg-fill-strong" />
              <span className="size-2.5 rounded-full bg-fill-strong" />
              <span className="ml-2 flex-1 text-xs text-fg-subtle">Terminal</span>
              <button
                type="button"
                onClick={() => void copy()}
                className="inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium text-fg-muted transition-colors hover:bg-hover hover:text-fg"
              >
                {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
            <pre className="overflow-x-auto p-5 font-mono text-[13px] leading-relaxed">
              {SETUP.split("\n").map((line, index) => (
                <span key={index} className={clsx("block", line.startsWith("#") ? "text-fg-subtle" : "text-fg")}>
                  {line.includes("  #") ? (
                    <>
                      {line.slice(0, line.indexOf("  #"))}
                      <span className="text-fg-subtle">{line.slice(line.indexOf("  #"))}</span>
                    </>
                  ) : (
                    line || " "
                  )}
                </span>
              ))}
            </pre>
          </div>
        </Reveal>
      </div>
    </Section>
  );
}

const FAQ: { q: string; a: string }[] = [
  {
    q: "Do I need API keys?",
    a: "No. TOT runs on your Claude Pro or Max and ChatGPT Plus or Pro logins, the same way Claude Code and Codex do. API keys only come in if you host TOT for other people.",
  },
  {
    q: "What does it cost?",
    a: "The subscriptions you already have. Cloud computers are optional: boat.dev bills per second while a VM runs. Without one, agents use a sandboxed folder on your Mac.",
  },
  {
    q: "Can I leave it running overnight?",
    a: "That's the idea. Tasks queue up, switch providers when one hits its limit, survive restarts and report everything back. They just won't merge, push to main or email anyone without you.",
  },
  {
    q: "Claude or ChatGPT?",
    a: "Both, if you have both. TOT picks per job, and reviews run on the other one, so code gets a second opinion from a different model.",
  },
  {
    q: "Why the mascots?",
    a: "A spinner can't look guilty when the tests fail.",
  },
  {
    q: "Can I use it from my phone?",
    a: "Yes. Set an access token and open it on your Wi-Fi, or from anywhere through an HTTPS tunnel. Voice input works over HTTPS.",
  },
];

export function Faq() {
  return (
    <Section id="faq">
      <Heading eyebrow="Questions" title="Fair questions." center />
      <Reveal className="mx-auto max-w-3xl">
        <div className="border-t border-hairline">
          {FAQ.map(({ q, a }, index) => (
            <details key={q} open={index === 0} className="group border-b border-hairline">
              <summary className="flex cursor-pointer list-none items-center gap-4 py-5 text-base font-medium text-fg-strong">
                <span className="flex-1">{q}</span>
                <Plus className="faq-chevron size-4.5 shrink-0 text-fg-subtle transition-transform duration-200" />
              </summary>
              <p className="-mt-1 pr-10 pb-5 text-base leading-relaxed text-fg-muted">{a}</p>
            </details>
          ))}
        </div>
      </Reveal>
    </Section>
  );
}
