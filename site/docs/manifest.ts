import type { MascotState } from "@shared/types";
import type { CrewMember } from "../crew";

/**
 * The docs' table of contents. Each page's text is a markdown file in ./content (named after its slug, or
 * index.md for the home page); this list gives the order, titles, descriptions and status shown around it.
 *
 * Status, for feature pages:
 * - "available": works today.
 * - "partly": works, with something missing; `missing` says what, in one line.
 * - "not-yet": planned, not built.
 * Guides (the home page, the status pages, the FAQ) have no status.
 *
 * Inside the markdown, a list item that starts with [Available], [Partly] or [Not yet] gets the same chip.
 */
export type Status = "available" | "partly" | "not-yet";

export type Group = "Get started" | "Use TOT" | "Devices" | "Reference";

export interface DocPage {
  /** URL segment: /docs/<slug>. "" is the docs home (/docs). */
  slug: string;
  title: string;
  /** Shorter label for the nav, when the title is long. */
  nav?: string;
  /** One sentence, under the title and in search. */
  description: string;
  group: Group;
  status?: Status;
  /** For "partly": what's missing, in one line. */
  missing?: string;
  mascot: CrewMember;
  mood?: MascotState;
}

export const GROUPS: Group[] = ["Get started", "Use TOT", "Devices", "Reference"];

export const PAGES: DocPage[] = [
  {
    slug: "",
    title: "What is TOT",
    description: "AI agents that run on the Claude and ChatGPT plans you already pay for, each with a mascot, a computer and a memory.",
    group: "Get started",
    mascot: "tot",
    mood: "speaking",
  },
  {
    slug: "install",
    title: "Install and first run",
    description: "Get TOT running on your Mac and log in to Claude, ChatGPT or both.",
    group: "Get started",
    status: "partly",
    missing: "TOT is in private preview: the code isn't public and the Mac app isn't signed or downloadable yet.",
    mascot: "ribbit",
    mood: "happy",
  },
  {
    slug: "agents",
    title: "Agents and chats",
    description: "Your agents, their mascots and models, and how you talk to them.",
    group: "Use TOT",
    status: "available",
    mascot: "mochi",
    mood: "happy",
  },
  {
    slug: "tasks",
    title: "Tasks",
    description: "Background work that keeps going while you chat, reports back on a card, and can be steered, paused or stopped.",
    group: "Use TOT",
    status: "available",
    mascot: "perry",
    mood: "working",
  },
  {
    slug: "projects",
    title: "Projects",
    description: "The things you work on: a GitHub repo, a folder on your Mac, or a topic. Any agent can work in any project.",
    group: "Use TOT",
    status: "partly",
    missing: "Folders on your Mac need a local computer; cloud computers can't open them yet.",
    mascot: "nova",
  },
  {
    slug: "mission-control",
    title: "Mission control",
    description: "Run many coding agents at once from one chat, see them all on one board, and land their code.",
    group: "Use TOT",
    status: "partly",
    missing: "After a draft PR is open, TOT doesn't follow its CI checks or review comments yet.",
    mascot: "splash",
    mood: "working",
  },
  {
    slug: "memory",
    title: "Memory",
    description: "Short facts your agents keep about you and your projects, stored as plain markdown with a full history.",
    group: "Use TOT",
    status: "available",
    mascot: "nimbus",
    mood: "sleeping",
  },
  {
    slug: "computers",
    title: "Computers",
    description: "Every agent gets a computer of its own: a sandboxed folder on your Mac, or a cloud machine with a desktop.",
    group: "Use TOT",
    status: "available",
    mascot: "bolt",
    mood: "working",
  },
  {
    slug: "apps",
    title: "Apps and plugins",
    description: "Connect GitHub, Slack, email, other apps and MCP servers, and decide what agents may do with them.",
    group: "Use TOT",
    status: "available",
    mascot: "rosy",
    mood: "happy",
  },
  {
    slug: "devices",
    title: "Use it from your phone and other computers",
    nav: "Phone and other computers",
    description: "Open TOT on your phone, and pair your Macs so each can use the other's agents.",
    group: "Devices",
    status: "partly",
    missing: "There's no iPhone app (TOT runs as a web app on your home screen), and agents can't move between computers.",
    mascot: "boo",
  },
  {
    slug: "mac-app",
    title: "The Mac app",
    description: "TOT as an app: its own window, a menu bar icon, and a server that keeps running when you close the window.",
    group: "Devices",
    status: "partly",
    missing: "Not signed or notarized, no auto-update, Apple silicon only, and no dictation in the app.",
    mascot: "tot",
  },
  {
    slug: "mobile-app",
    title: "The iPhone app",
    description: "Every agent on every paired Mac, their chats, live replies and approvals, from your phone.",
    group: "Devices",
    status: "partly",
    missing: "In development: no App Store or TestFlight build yet, and no tasks, projects, settings or notifications in it yet.",
    mascot: "splash",
  },
  {
    slug: "safety",
    title: "Safety and your rules",
    description: "What TOT never does, what it asks you first, and how your files and secrets are kept safe.",
    group: "Reference",
    status: "available",
    mascot: "perry",
    mood: "thinking",
  },
  {
    slug: "status",
    title: "What's in TOT",
    description: "Every feature area, and whether it's available, partly there, or not built yet.",
    group: "Reference",
    mascot: "nova",
    mood: "happy",
  },
  {
    slug: "not-yet",
    title: "Not yet",
    description: "What TOT doesn't do today, in plain words, and what's planned.",
    group: "Reference",
    mascot: "ribbit",
    mood: "sleeping",
  },
  {
    slug: "faq",
    title: "FAQ",
    description: "Short answers to common questions.",
    group: "Reference",
    mascot: "mochi",
    mood: "speaking",
  },
];

export const STATUS_LABEL: Record<Status, string> = { available: "Available", partly: "Partly", "not-yet": "Not yet" };

export const pageFor = (slug: string) => PAGES.find((page) => page.slug === slug);
