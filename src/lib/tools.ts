import type { LucideIcon } from "lucide-react";
import {
  BookOpen,
  Brain,
  Camera,
  Command,
  ExternalLink,
  FilePen,
  FileText,
  GitBranch,
  Globe,
  Keyboard,
  LayoutGrid,
  Link,
  ListChecks,
  Monitor,
  MousePointerClick,
  MoveVertical,
  Puzzle,
  SquareKanban,
  Terminal,
  Wrench,
} from "lucide-react";
import type { Message, MessagePart } from "@shared/types";
import { truncate, truncateStart } from "./format";

export type ToolPart = Extract<MessagePart, { type: "tool" }>;

const ICONS: Record<string, LucideIcon> = {
  computer_exec: Terminal,
  computer_read_file: FileText,
  computer_write_file: FilePen,
  computer_expose_port: ExternalLink,
  computer_info: Monitor,
  computer_screenshot: Camera,
  computer_click: MousePointerClick,
  computer_type: Keyboard,
  computer_key: Command,
  computer_scroll: MoveVertical,
  computer_open_url: Link,
  web_search: Globe,
  web_fetch: Globe,
  mission_overview: SquareKanban,
};

export function toolIcon(name: string): LucideIcon {
  if (ICONS[name]) return ICONS[name];
  if (name.startsWith("memory_")) return Brain;
  if (name.startsWith("wiki_")) return BookOpen;
  if (name.startsWith("task_")) return ListChecks;
  // lucide-react dropped brand marks (no "Github"); GitBranch is the closest stand-in.
  if (name.startsWith("github/")) return GitBranch;
  if (name.startsWith("apps/")) return LayoutGrid;
  if (name.includes("/")) return Puzzle;
  return Wrench;
}

/** Title-cases a slug like "google-calendar" -> "Google Calendar". */
function titleCaseSlug(slug: string): string {
  return slug
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

const APPS_INTEGRATION_PATTERN = /tools\.([a-zA-Z0-9_-]+)/;

/** The connected app a piece of `apps/execute` code talks to (`tools.gmail...` -> "Gmail"), if recognizable. */
function appsIntegrationOf(code: string): string | null {
  const match = APPS_INTEGRATION_PATTERN.exec(code);
  return match ? titleCaseSlug(match[1]) : null;
}

function inputRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

/** First string (or number) value found under any of `keys`. */
function pick(input: unknown, ...keys: string[]): string {
  const record = inputRecord(input);
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number") return String(value);
  }
  return "";
}

export function commandOf(part: ToolPart): string {
  return typeof part.input === "string" ? part.input : pick(part.input, "command", "cmd", "script");
}

function hostOf(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname.replace(/^www\./, "") + (parsed.pathname === "/" ? "" : parsed.pathname);
  } catch {
    return url;
  }
}

function humanize(name: string): string {
  const words = name.replace(/[_-]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Short labels for GitHub's common MCP tools (owner/repo, issue/PR numbers,
 * search queries…), read defensively since the server's own tool list can
 * change. Anything not covered here falls back to "github · Tool name" below.
 */
function githubToolTitle(tool: string, part: ToolPart): string | null {
  const running = part.status === "running";
  const verb = (active: string, done: string) => (running ? active : done);
  const input = part.input;
  const owner = pick(input, "owner");
  const repo = pick(input, "repo");
  const repoLabel = owner && repo ? `${owner}/${repo}` : repo;
  const issueNumber = pick(input, "issue_number", "issueNumber");
  const prNumber = pick(input, "pullNumber", "pull_number", "pr_number");

  switch (tool) {
    case "search_issues": {
      const query = pick(input, "query", "q");
      return query
        ? `${verb("Searching", "Searched")} GitHub issues for “${truncate(query, 56)}”`
        : verb("Searching GitHub issues", "Searched GitHub issues");
    }
    case "search_code": {
      const query = pick(input, "query", "q");
      return query
        ? `${verb("Searching", "Searched")} GitHub code for “${truncate(query, 56)}”`
        : verb("Searching GitHub code", "Searched GitHub code");
    }
    case "search_pull_requests": {
      const query = pick(input, "query", "q");
      return query
        ? `${verb("Searching", "Searched")} GitHub pull requests for “${truncate(query, 56)}”`
        : verb("Searching GitHub pull requests", "Searched GitHub pull requests");
    }
    case "search_repositories": {
      const query = pick(input, "query", "q");
      return query
        ? `${verb("Searching", "Searched")} GitHub repositories for “${truncate(query, 56)}”`
        : verb("Searching GitHub repositories", "Searched GitHub repositories");
    }
    case "issue_read":
      return repoLabel && issueNumber
        ? `${verb("Reading", "Read")} ${repoLabel}#${issueNumber}`
        : verb("Reading an issue", "Read an issue");
    case "pull_request_read":
      return repoLabel && prNumber
        ? `${verb("Reading", "Read")} ${repoLabel}#${prNumber}`
        : verb("Reading a pull request", "Read a pull request");
    case "get_file_contents": {
      const path = pick(input, "path");
      return path
        ? `${verb("Reading", "Read")} \`${truncateStart(path, 56)}\`${repoLabel ? ` in ${repoLabel}` : ""}`
        : verb("Reading a file", "Read a file");
    }
    case "list_issues":
      return repoLabel ? `${verb("Listing", "Listed")} issues in ${repoLabel}` : verb("Listing issues", "Listed issues");
    case "list_pull_requests":
      return repoLabel
        ? `${verb("Listing", "Listed")} pull requests in ${repoLabel}`
        : verb("Listing pull requests", "Listed pull requests");
    case "list_commits":
      return repoLabel ? `${verb("Listing", "Listed")} commits in ${repoLabel}` : verb("Listing commits", "Listed commits");
    case "get_commit": {
      const sha = pick(input, "sha", "commit_sha", "ref");
      return repoLabel && sha
        ? `${verb("Reading", "Read")} commit ${repoLabel}@${truncate(sha, 7)}`
        : verb("Reading a commit", "Read a commit");
    }
    case "create_pull_request": {
      const title = pick(input, "title");
      return title
        ? `${verb("Opening", "Opened")} a pull request: “${truncate(title, 56)}”`
        : verb("Opening a pull request", "Opened a pull request");
    }
    case "create_branch": {
      const branch = pick(input, "branch");
      return branch
        ? `${verb("Creating", "Created")} branch \`${branch}\`${repoLabel ? ` in ${repoLabel}` : ""}`
        : verb("Creating a branch", "Created a branch");
    }
    case "add_issue_comment":
      return repoLabel && issueNumber
        ? `${verb("Commenting on", "Commented on")} ${repoLabel}#${issueNumber}`
        : verb("Commenting on an issue", "Commented on an issue");
    case "issue_write": {
      if (issueNumber) {
        return repoLabel
          ? `${verb("Updating", "Updated")} ${repoLabel}#${issueNumber}`
          : verb("Updating an issue", "Updated an issue");
      }
      const title = pick(input, "title");
      return title
        ? `${verb("Opening", "Opened")} an issue: “${truncate(title, 56)}”`
        : verb("Opening an issue", "Opened an issue");
    }
    case "update_pull_request":
      return repoLabel && prNumber
        ? `${verb("Updating", "Updated")} ${repoLabel}#${prNumber}`
        : verb("Updating a pull request", "Updated a pull request");
    case "push_files":
      return repoLabel ? `${verb("Pushing", "Pushed")} files to ${repoLabel}` : verb("Pushing files", "Pushed files");
    case "create_or_update_file": {
      const path = pick(input, "path");
      return path
        ? `${verb("Writing", "Wrote")} \`${truncateStart(path, 56)}\`${repoLabel ? ` in ${repoLabel}` : ""}`
        : verb("Writing a file", "Wrote a file");
    }
    default:
      return null;
  }
}

/**
 * Short label for a tool call. Backticks mark inline code. Uses the server's
 * `title` when present, otherwise derives one from the tool name and input.
 */
export function toolTitle(part: ToolPart): string {
  if (part.title) return part.title;
  const running = part.status === "running";
  const verb = (active: string, done: string) => (running ? active : done);
  const input = part.input;

  if (part.name.startsWith("github/")) {
    const label = githubToolTitle(part.name.slice("github/".length), part);
    if (label) return label;
  }

  switch (part.name) {
    case "computer_exec": {
      const command = commandOf(part);
      return command
        ? `${verb("Running", "Ran")} \`${truncate(command, 72)}\``
        : verb("Running a command", "Ran a command");
    }
    case "computer_read_file": {
      const path = pick(input, "path", "file", "filePath", "filename");
      return path ? `${verb("Reading", "Read")} \`${truncateStart(path, 56)}\`` : verb("Reading a file", "Read a file");
    }
    case "computer_write_file": {
      const path = pick(input, "path", "file", "filePath", "filename");
      return path ? `${verb("Writing", "Wrote")} \`${truncateStart(path, 56)}\`` : verb("Writing a file", "Wrote a file");
    }
    case "computer_expose_port": {
      const port = pick(input, "port");
      return port ? `${verb("Exposing", "Exposed")} port ${port}` : verb("Exposing a port", "Exposed a port");
    }
    case "computer_info":
      return verb("Checking the computer", "Checked the computer");
    case "computer_screenshot":
      return verb("Taking a screenshot", "Took a screenshot");
    case "computer_click": {
      const x = pick(input, "x");
      const y = pick(input, "y");
      return x && y ? `${verb("Clicking", "Clicked")} (${x}, ${y})` : verb("Clicking", "Clicked");
    }
    case "computer_type": {
      const value = pick(input, "text", "content", "value");
      return value ? `${verb("Typing", "Typed")} “${truncate(value, 60)}”` : verb("Typing", "Typed");
    }
    case "computer_key": {
      const keys = pick(input, "key", "keys", "combo");
      return keys ? `${verb("Pressing", "Pressed")} \`${keys}\`` : verb("Pressing a key", "Pressed a key");
    }
    case "computer_scroll": {
      const direction = pick(input, "direction");
      return direction ? `${verb("Scrolling", "Scrolled")} ${direction}` : verb("Scrolling", "Scrolled");
    }
    case "computer_open_url": {
      const url = pick(input, "url", "uri", "href");
      return url ? `${verb("Opening", "Opened")} ${truncate(hostOf(url), 64)}` : verb("Opening a page", "Opened a page");
    }
    case "web_search": {
      const query = pick(input, "query", "q", "search");
      return query ? `${verb("Searching", "Searched")} “${truncate(query, 72)}”` : verb("Searching the web", "Searched the web");
    }
    case "web_fetch": {
      const url = pick(input, "url", "uri", "href");
      return url ? `${verb("Reading", "Read")} ${truncate(hostOf(url), 64)}` : verb("Fetching a page", "Fetched a page");
    }
    case "memory_save":
      return verb("Updating memory", "Memory updated");
    case "memory_search": {
      const query = pick(input, "query", "q");
      return query ? `${verb("Searching", "Searched")} memory for “${truncate(query, 56)}”` : verb("Searching memory", "Searched memory");
    }
    case "memory_update":
      return verb("Updating memory", "Memory updated");
    case "memory_delete":
      return verb("Forgetting a memory", "Forgot a memory");
    case "chat_search": {
      const query = pick(input, "query", "q");
      return query ? `${verb("Searching", "Searched")} earlier chats for “${truncate(query, 48)}”` : verb("Searching earlier chats", "Searched earlier chats");
    }
    case "chat_read":
      return verb("Reading an earlier chat", "Read an earlier chat");
    case "wiki_search": {
      const query = pick(input, "query", "q");
      return query
        ? `${verb("Searching", "Searched")} the wiki for “${truncate(query, 56)}”`
        : verb("Searching the wiki", "Searched the wiki");
    }
    case "wiki_read": {
      const page = pick(input, "page");
      return page ? `${verb("Reading", "Read")} wiki · ${truncate(page, 48)}` : verb("Reading the wiki", "Read the wiki");
    }
    case "wiki_write":
    case "wiki_edit": {
      const label = pick(input, "title", "page");
      return label ? `${verb("Updating", "Updated")} wiki · ${truncate(label, 48)}` : verb("Updating the wiki", "Updated the wiki");
    }
    case "wiki_delete":
      return verb("Removing a wiki page", "Removed a wiki page");
    case "apps/execute": {
      const integration = appsIntegrationOf(pick(input, "code"));
      return integration ? verb(`Using ${integration}`, `Used ${integration}`) : verb("Using your apps", "Used your apps");
    }
    case "apps/skills":
      return "Looking up how to use your apps";
  }

  const slash = part.name.indexOf("/");
  if (slash > 0) return `${part.name.slice(0, slash)} · ${humanize(part.name.slice(slash + 1))}`;
  return humanize(part.name);
}

/** What to show in the "input" box of an expanded tool card. */
export function toolInputText(part: ToolPart): string {
  if (part.name === "computer_exec") {
    const command = commandOf(part);
    if (command) return `$ ${command}`;
  }
  if (part.name === "apps/execute") {
    const code = pick(part.input, "code");
    if (code) return code;
  }
  const { input } = part;
  if (input === undefined || input === null) return "";
  if (typeof input === "string") return input;
  if (typeof input === "object" && Object.keys(input).length === 0) return "";
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

export type ToolDisplayStatus = "running" | "done" | "error" | "interrupted";

/** A tool still "running" in a message that is no longer streaming was cut off. */
export function toolDisplayStatus(part: ToolPart, live: boolean): ToolDisplayStatus {
  if (part.status === "error" || part.isError) return "error";
  if (part.status === "running") return live ? "running" : "interrupted";
  return "done";
}

const MAX_OUTPUT_CHARS = 20_000;

/** Keep huge tool outputs from bloating the DOM. */
export function clipOutput(text: string, max = MAX_OUTPUT_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${(text.length - max).toLocaleString()} more characters)` : text;
}

/** First few lines of an output, for compact previews. */
export function previewOutput(text: string, lines = 4, chars = 280): string {
  const head = text.trim().split("\n").slice(0, lines).join("\n");
  return head.length > chars ? `${head.slice(0, chars - 1)}…` : head;
}

export function memoryTextOf(part: ToolPart): string {
  return pick(part.input, "content", "text", "memory", "fact") || part.output || "";
}

/** What changed, for the wiki_write/wiki_edit pill's expanded preview. */
export function wikiPreviewOf(part: ToolPart): string {
  const text = part.name === "wiki_edit" ? pick(part.input, "new_text") : pick(part.input, "content");
  return text ? previewOutput(text, 8, 600) : "";
}

const URL_PATTERN = /https?:\/\/[^\s"'<>)\]}]+/;

export function firstUrl(text: string | undefined): string | null {
  return text ? (URL_PATTERN.exec(text)?.[0] ?? null) : null;
}

/** Tool calls that touched the computer, newest first. */
export function computerActivity(messages: Message[], limit = 60): ToolPart[] {
  const parts: ToolPart[] = [];
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "tool" && part.name.startsWith("computer_")) parts.push(part);
    }
  }
  return parts.reverse().slice(0, limit);
}

/** Plain text of a message (its text parts), for copying. */
export function messageText(message: Message): string {
  return message.parts
    .filter((part): part is Extract<MessagePart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n\n")
    .trim();
}
