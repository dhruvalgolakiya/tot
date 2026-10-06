import type { ComponentType } from "react";
import { Brain, IdCard, LayoutGrid, ListChecks, Monitor, MonitorSmartphone, Plug, SlidersHorizontal, Sparkles } from "lucide-react";
import type { SettingsSection } from "../../lib/router";
import { GitHubMark } from "../ui/GitHubMark";
import { SlackMark } from "../ui/SlackMark";

export interface SettingsSectionMeta {
  id: SettingsSection;
  label: string;
  /** One-line muted description shown under the section title. */
  description: string;
  icon: ComponentType<{ className?: string }>;
  /** General / Models / Computer / Tasks share one draft + the sticky Save bar; the rest apply changes immediately. */
  hasDraft: boolean;
}

/** Settings nav order, shared by the desktop nav panel and the mobile section list. */
export const SETTINGS_SECTIONS: SettingsSectionMeta[] = [
  {
    id: "general",
    label: "General",
    description: "Your name, custom instructions, default model, and appearance.",
    icon: SlidersHorizontal,
    hasDraft: true,
  },
  {
    id: "devices",
    label: "Devices",
    description: "This computer's name and address, and the browsers and phones signed in to it.",
    icon: MonitorSmartphone,
    hasDraft: false,
  },
  {
    id: "models",
    label: "Models",
    description: "Connect Claude and ChatGPT with the subscriptions you already have.",
    icon: Sparkles,
    hasDraft: true,
  },
  {
    id: "memory",
    label: "Memory",
    description: "What your agents remember, about you and about each project, kept as git repos with history and undo.",
    icon: Brain,
    hasDraft: false,
  },
  {
    id: "computer",
    label: "Computer",
    description: "Choose where agents run commands: a cloud VM, a local sandbox, or off.",
    icon: Monitor,
    hasDraft: true,
  },
  {
    id: "tasks",
    label: "Tasks",
    description: "How many tasks run at once, what happens after a restart, and who hears when they're done.",
    icon: ListChecks,
    hasDraft: true,
  },
  {
    id: "github",
    label: "GitHub",
    description: "Give agents GitHub access for issues, pull requests, and private repos.",
    icon: GitHubMark,
    hasDraft: false,
  },
  {
    id: "workflows",
    label: "Workflows",
    description: "How agents work through coding tasks: playbooks, plan approval, and independent reviews.",
    icon: ListChecks,
    hasDraft: false,
  },
  {
    id: "apps",
    label: "Apps",
    description: "Connect Gmail, Linear, Notion and more once; every agent can use them. Actions that change things ask for your OK first.",
    icon: LayoutGrid,
    hasDraft: false,
  },
  {
    id: "slack",
    label: "Slack",
    description: "Message your agents from Slack. Each thread becomes a chat with the thread as context.",
    icon: SlackMark,
    hasDraft: false,
  },
  {
    id: "personas",
    label: "Personas",
    description: "Give an agent its own email and GitHub account, so its work shows up as itself, not you.",
    icon: IdCard,
    hasDraft: false,
  },
  {
    id: "plugins",
    label: "Plugins",
    description: "Add other MCP servers for more tools, like Linear or your own APIs.",
    icon: Plug,
    hasDraft: false,
  },
];
