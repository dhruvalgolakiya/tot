// Contracts shared by the TOT server (apps/server/) and web client (apps/web/src/).
// Everything that crosses the HTTP boundary is defined here.

export type ProviderId = "claude" | "chatgpt";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

// ---------------------------------------------------------------------------
// Models & providers
// ---------------------------------------------------------------------------

/**
 * A model the user can pick in the model menu. The client only ever sends
 * `id` back to the server. The special id "auto" lets TOT route each turn:
 * light turns -> Claude Sonnet 5.5, complex turns -> Claude Opus 5.5.
 */
export interface ModelOption {
  /**
   * "auto" | "<account>:<model>", e.g. "claude:claude-opus-5-5", "chatgpt:gpt-5.5". The built-in accounts' ids are
   * "claude" and "chatgpt", so older ids keep working; another account's models carry its id ("claude-mix:…").
   */
  id: string;
  provider: ProviderId | "auto";
  /** The provider account the model runs on (Provider accounts); absent for "auto". */
  accountId?: string;
  /** That account's name, for grouping the model menu ("Claude Mix"). */
  accountName?: string;
  /** Provider-native model id ("claude-opus-5-5"), or "auto". */
  model: string;
  label: string;
  description?: string;
  available: boolean;
  unavailableReason?: string;
}

export interface ProviderStatus {
  id: ProviderId;
  /** The provider account this status is for; the built-in one ("claude" / "chatgpt") when absent. */
  accountId?: string;
  /** "Claude" | "ChatGPT" */
  label: string;
  /** The local harness (Claude Code / Codex CLI) was found. */
  installed: boolean;
  loggedIn: boolean;
  /** e.g. "Claude subscription", "ChatGPT Plus", "API key" */
  authMethod?: string;
  /** Non-secret account hint (email or plan), if known. */
  account?: string;
  /** Human-readable hint: how to log in, or the last error. */
  detail?: string;
  models: ModelOption[];
}

// ---------------------------------------------------------------------------
// Agents & mascots
//
// An agent is a workspace (like a project, team or company): a name, a mascot,
// a personality, its own computer, its own notebook brain and routines, any
// shared brains attached to it, and any number of chats. Chats are tasks inside
// the workspace (e.g. one per ticket): each new chat starts with its brains'
// cards, the notebook's Overview and page index, the brains the request is
// about, the pages most relevant to it, and a list of recent chats; it can search earlier
// chats. Memory about the user is shared by every agent. A default agent
// ("Tot") always exists.
// ---------------------------------------------------------------------------

export type MascotShape =
  | "blob"
  | "cloud"
  | "pear"
  | "star"
  | "heart"
  | "drop"
  | "bot"
  | "ghost"
  | "frog"
  | "cat";

export type MascotAccessory =
  | "none"
  | "glasses"
  | "sunglasses"
  | "bowtie"
  | "beret"
  | "headphones"
  | "cap"
  | "antenna"
  | "crown"
  | "scarf";

export type MascotEyes = "dots" | "happy" | "wide" | "sleepy";

/** Everything needed to draw an agent's mascot; small enough to store as JSON. */
export interface MascotSpec {
  shape: MascotShape;
  /** Main body color, "#rrggbb". */
  color: string;
  accessory: MascotAccessory;
  eyes: MascotEyes;
}

/**
 * What the mascot is doing right now (derived client-side from the run stream):
 * idle → blinking/bobbing, thinking → reasoning, working → running a tool,
 * speaking → streaming text, happy → just finished, error → turn failed,
 * sleeping → its computer is stopped.
 */
export type MascotState = "idle" | "thinking" | "working" | "speaking" | "happy" | "error" | "sleeping";

/** The islands of the hero scene (apps/web/public/hero/islands/<id>.webp, plus <id>-dawn.webp for light mode); each agent works from one. */
export type AgentIsland = "workshop" | "observatory" | "tower" | "greenhouse";

export interface Agent {
  id: string;
  name: string;
  mascot: MascotSpec;
  /** The island it works from: the one picked, or assigned round-robin by creation order. */
  island: AgentIsland;
  /** A few words under its name ("the workshop"); empty shows the island's name instead. */
  tagline: string;
  /** Personality and standing instructions, added to the system prompt. */
  instructions: string;
  /** ModelOption id new chats with this agent start with ("auto" by default). */
  modelId: string;
  /** The agent's own computer (shared by all of its chats); null until first used. */
  computer: ComputerSummary | null;
  /** The persona it works as (its own email, git author and GitHub account); null = as the user. */
  personaId: string | null;
  /** What's in the workspace, for the sidebar. */
  counts: { chats: number; pages: number; routines: number };
  /** Its task queue is paused: a task failed on repeated provider errors (module 05). */
  queueHold: QueueHold | null;
  createdAt: number;
  updatedAt: number;
  /** Set by the client for another device's agent: the paired device it lives on (module 07). */
  deviceId?: string;
}

export interface AgentInput {
  name: string;
  mascot: MascotSpec;
  /** null = back to the round-robin default. */
  island?: AgentIsland | null;
  tagline?: string;
  instructions?: string;
  modelId?: string;
  /** null = works as the user. */
  personaId?: string | null;
}

/**
 * When a routine runs, in the server's local time. Intervals are at least 15 minutes.
 * `days` uses 0 = Sunday … 6 = Saturday; omitted means every day.
 */
export type RoutineSchedule =
  | { kind: "interval"; everyMinutes: number }
  | { kind: "daily"; time: string; days?: number[] };

/**
 * A recurring task an agent runs on its own (like "every weekday at 8:00,
 * summarize the news"). Each run starts a new chat with the agent.
 */
export interface Routine {
  id: string;
  agentId: string;
  name: string;
  /** What the agent is asked to do each time. */
  prompt: string;
  schedule: RoutineSchedule;
  enabled: boolean;
  lastRunAt: number | null;
  nextRunAt: number | null;
  /** The chat created by the most recent run. */
  lastConversationId: string | null;
  createdAt: number;
  /** Module 12: a project's schedule. It runs in the project's Lead (a "schedule" signal), not a new chat. */
  projectId?: string | null;
}

export interface RoutineInput {
  name: string;
  prompt: string;
  schedule: RoutineSchedule;
  enabled?: boolean;
  /** Module 12: a project's schedule (see Routine.projectId). */
  projectId?: string | null;
}

// ---------------------------------------------------------------------------
// Conversations & messages
// ---------------------------------------------------------------------------

export interface Conversation {
  id: string;
  /** The agent this chat is with. */
  agentId: string;
  /** Set when a routine started this chat. */
  routineId: string | null;
  title: string;
  /** Last ModelOption id picked for this chat ("auto" by default). */
  modelId: string;
  /** Provider that owns the current agent session, null before the first turn. */
  provider: ProviderId | null;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  /** The agent's computer (the same one across all of that agent's chats). */
  computer: ComputerSummary | null;
  /** Where the chat was started from outside TOT, e.g. a Slack thread; null for chats started in TOT. */
  origin: ConversationOrigin | null;
  /** "chat" talks with the user; "task" works in the background until it's done (see TaskInfo). */
  kind: ConversationKind;
  /** The chat a task was started from (its card shows there); null for chats and top-level tasks. */
  parentId: string | null;
  /** Set for tasks: goal, status, plan, branch…; null for chats. */
  task: TaskInfo | null;
  /** A fork (module 05): the chat and the message it was forked at; null otherwise. */
  forkedFrom: ForkOrigin | null;
  /** The project it's in (module 06); null for chats in no project. Tasks and forks take their chat's. */
  projectId: string | null;
  /** Module 11: the project's Lead chat (its orchestrator). */
  lead?: boolean;
  /**
   * Where a chat in a code project works, picked before its first message: the project's main checkout, or a
   * worktree of its own on a new tot/… branch. Absent for chats from before (they only read the project's
   * folder) and for tasks, which have their own worktree (TaskInfo.repo).
   */
  workspace?: ChatWorkspace | null;
}

/** The two places a new chat in a code project can work. */
export type ChatWorkspaceMode = "checkout" | "worktree";

export type ChatWorkspace =
  | { mode: "checkout" }
  | {
      mode: "worktree";
      /** The project repo it works in (its name; the primary's). */
      repo: string;
      /** "tot/<slug>-<4 hex>", named on its first message; null until then. */
      branch: string | null;
      /** <repo folder>/.tot-worktrees/<branch slug>, on the agent's computer (a full path for a folder on this Mac). */
      worktree: string | null;
      /** The branch it started from, once the worktree is made. */
      baseBranch: string | null;
      /** Whether the worktree has been made (on the chat's first turn). */
      created: boolean;
    };

export type ConversationKind = "chat" | "task";

export interface ConversationOrigin {
  /** Where the work came from: a Slack thread, an email, or a ticket (module 06). */
  kind: "slack" | "email" | "linear" | "github";
  /** e.g. "#eng", "DM with Dhruval", "Email from Dhruval" or "ENG-123 · Checkout is flaky". */
  label: string;
  /** Link to the Slack thread or the ticket, when known (null for email). */
  url: string | null;
  /** A ticket's key, e.g. "ENG-123" or "acme/web#42"; it goes into task branch names. Null otherwise. */
  key?: string | null;
}

export type MessageRole = "user" | "assistant";
export type MessageStatus = "streaming" | "complete" | "error" | "stopped";

export type ToolStatus = "running" | "done" | "error";

/**
 * Normalized tool names used in `tool` parts (provider prefixes stripped):
 *  - TOT computer:  computer_exec, computer_read_file, computer_write_file,
 *                   computer_expose_port, computer_info
 *  - TOT desktop:   computer_screenshot, computer_click, computer_type,
 *                   computer_key, computer_scroll, computer_open_url
 *                   (GUI control of Boat VMs; a screenshot's output contains
 *                   a line "screenshot: <url>" the UI can render)
 *  - TOT memory:    memory_save, memory_search, memory_update, memory_delete, memory_read
 *                   (git repos of markdown: about the user, and per project; module 10)
 *  - TOT wiki:      wiki_search, wiki_read, wiki_write, wiki_edit, wiki_delete
 *  - TOT chats:     chat_search, chat_read (earlier chats in the same workspace)
 *  - TOT projects:  chat_set_project (file a chat that's in no project), ticket_link (module 06)
 *  - TOT routines:  routine_create, routine_list, routine_delete
 *  - TOT email:     email_inbox, email_search, email_read, email_send, email_reply, email_wait
 *                   (agents working as a persona with a mailbox; sending asks the user first)
 *  - Built-ins:     web_search, web_fetch
 *  - GitHub:        "github/<tool>" (GitHub's MCP server when connected, e.g. "github/search_issues")
 *  - Apps:          "apps/execute" (runs TypeScript calling the user's connected apps; input { code }),
 *                   "apps/skills"
 *  - Plugins:       "<plugin>/<tool>"  (e.g. "linear/create_issue")
 *  - Anything else: provider's own name
 */
export type MessagePart =
  | { type: "text"; id: string; text: string }
  | { type: "reasoning"; id: string; text: string; durationMs?: number }
  | {
      type: "tool";
      id: string;
      name: string;
      /** Short human label, e.g. "Ran npm test" / "Searched the web". */
      title?: string;
      input?: unknown;
      output?: string;
      isError?: boolean;
      status: ToolStatus;
      /**
       * Set when the chat was loaded clipped (GET /api/conversations/:id?clip=1) and this call's output, or a long
       * string in its input, was cut to its start: GET /api/conversations/:id/messages/:messageId/parts/:partId has it whole.
       */
      clipped?: boolean;
      /** With `clipped`: the whole output's length in characters, when it was cut. */
      outputChars?: number;
      /** With `clipped`: the whole input's length in characters (as JSON unless it's a string), when it was cut. */
      inputChars?: number;
    }
  | {
      type: "notice";
      id: string;
      kind: "memory" | "wiki" | "computer" | "route" | "info" | "warning";
      text: string;
      /** For "wiki": the pages that changed, so the UI can link to them. */
      pageIds?: string[];
      /** For a chat filed under a project ("Filed under web", module 06): the project, so the UI can offer Move. */
      projectId?: string;
      /** For "Best of 2 finished" (module 09): the best-of group, so the UI can offer Compare. */
      group?: string;
      /** For "“Research” is done: …" in the chat that started a task: the task, so the UI can open it. */
      taskId?: string;
    }
  /** A file the user attached (images render inline). */
  | { type: "file"; id: string; attachment: Attachment }
  /**
   * A tool paused the turn to ask the user something (an MCP elicitation): approve
   * an action ("confirm"), finish something in the browser ("url"), or fill a few
   * fields ("form"). Answer with POST /api/runs/:runId/approvals/:id while "pending".
   */
  | {
      type: "approval";
      id: string;
      /** Who's asking, e.g. "Apps" (Executor) or a plugin's name. */
      source: string;
      message: string;
      kind: "confirm" | "url" | "form";
      /** kind "url": the page to open; answer "accept" once it's done there. */
      url?: string;
      /** kind "form": what to fill in. */
      fields?: ApprovalField[];
      status: "pending" | "accepted" | "declined" | "expired";
      /** An unanswered request is declined at this time. */
      expiresAt: number;
      /**
       * A project Lead's request to land or discard a task (module 11), or to push a draft PR's new commits (module 12):
       * it waits for the user as long as it takes, after the turn too, and is answered with POST /api/lead/asks/:id, not
       * the run's approval route.
       */
      lead?: { action: "land" | "discard" | "push"; taskId: string };
    }
  /** A task started from this chat. The UI shows it as a live card that reads the task's current state, so the part only holds its id. */
  | { type: "task"; id: string; taskId: string };

export interface ApprovalField {
  name: string;
  label: string;
  type: "string" | "number" | "boolean" | "enum";
  required: boolean;
  description?: string;
  /** type "enum": the choices. */
  options?: string[];
  default?: string | number | boolean;
}

export interface ApprovalAnswer {
  decision: "accept" | "decline";
  /** kind "form": the values, keyed by field name. */
  values?: Record<string, string | number | boolean>;
}

/** A file uploaded with POST /api/uploads, referenced by id when sending a message. */
export interface Attachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  /** Where the browser can fetch it (GET). */
  url: string;
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  /** Equivalent API cost reported by the harness; subscription usage isn't billed per token. */
  costUsd?: number;
  durationMs?: number;
}

export interface Message {
  id: string;
  conversationId: string;
  role: MessageRole;
  parts: MessagePart[];
  status: MessageStatus;
  provider?: ProviderId;
  /** The provider account that answered (Provider accounts); the built-in one when absent. */
  account?: string;
  /** Provider-native model id actually used for this turn. */
  model?: string;
  /** Why TOT picked this model, e.g. "Auto · complex task → Opus 5.5". */
  routeReason?: string;
  error?: string;
  usage?: Usage;
  /** User messages sent to a task while it was running ("steering"). */
  steered?: boolean;
  /** A steer handed to the model mid-reply: that reply, and the part it arrived after (the UI shows the note inside the reply). */
  steeredInto?: { messageId: string; afterPartId: string | null };
  /** Written by TOT to keep a task going, e.g. "Continue the task"; shown as a quiet divider rather than a bubble. */
  auto?: boolean;
  /** User messages: chats attached as reference (module 05). */
  contextChats?: string[];
  /** User messages: the skill invoked with it ("/dh-stack …"), shown as a chip; its SKILL.md went to the model, not here. */
  skill?: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Streaming run events (Server-Sent Events on GET /api/runs/:runId/events)
// Every SSE message: `id: <seq>` and `data: <JSON RunEvent>`. Reconnecting with
// Last-Event-ID replays everything after that seq.
// ---------------------------------------------------------------------------

export type RunEvent =
  | {
      type: "run-start";
      runId: string;
      conversationId: string;
      /** id of the assistant message being produced */
      messageId: string;
      provider: ProviderId;
      model: string;
      routeReason?: string;
    }
  /** Append a new part to the assistant message. */
  | { type: "part-start"; part: MessagePart }
  /** Append text to an existing text/reasoning part. */
  | { type: "part-delta"; partId: string; delta: string }
  /** Replace an existing part (same id), e.g. a tool call finished. */
  | { type: "part-update"; part: MessagePart }
  /** Conversation metadata changed (title generated, provider bound...). */
  | { type: "conversation"; conversation: Conversation }
  /** The conversation's computer changed state. */
  | { type: "computer"; computer: ComputerSummary }
  | { type: "usage"; usage: Usage }
  | { type: "error"; message: string }
  /** Terminal event. `message` is the final persisted assistant message; `errorKind` says why it failed, when known. */
  | { type: "run-end"; status: MessageStatus; message: Message; errorKind?: TurnErrorKind };

/** Why a turn failed: a usage limit, not logged in, or the turn's own problem (too many steps, too long for the context window). */
export type TurnErrorKind = "limit" | "auth" | "turn";

// ---------------------------------------------------------------------------
// App-wide live updates (Server-Sent Events on GET /api/events). No replay:
// after a reconnect, refetch lists. Lets every tab see background work such as
// routine runs, new chats and titles, agents' computers.
// ---------------------------------------------------------------------------

export type RunStatus = "running" | "complete" | "error" | "stopped";

export type AppEvent =
  | { type: "conversation"; conversation: Conversation }
  | { type: "conversation-deleted"; conversationId: string }
  | { type: "run"; runId: string; conversationId: string; agentId: string; status: RunStatus }
  | { type: "computer"; agentId: string; computer: ComputerSummary }
  | { type: "agent"; agent: Agent }
  | { type: "agent-deleted"; agentId: string }
  /** A brain's pages changed; `conversationId` is set when a chat's messages changed too (keeper notice). */
  | { type: "wiki"; brainId: string; conversationId?: string }
  /** Brains were added, removed, renamed, or attached to / detached from agents. */
  | { type: "brains"; brains: Brain[] }
  /** The GitHub connection changed (connected, disconnected, writes toggled). */
  | { type: "github"; status: GitHubStatus }
  /** The Slack bot's state or its people changed. */
  | { type: "slack"; status: SlackStatus }
  /** Apps (Executor) changed state or connected apps changed. */
  | { type: "apps"; status: AppsStatus }
  /** A persona was created or changed (mailbox state, unread count, GitHub, agents). */
  | { type: "persona"; persona: Persona }
  | { type: "persona-deleted"; personaId: string }
  /** New mail in a persona's mailbox (incoming or sent). */
  | { type: "mail"; personaId: string; mail: MailSummary }
  /** A chat is waiting for the user's approval (pending) or no longer is, e.g. a background routine run. */
  | { type: "approval"; agentId: string; conversationId: string; runId: string; partId: string; message: string; pending: boolean }
  /** A task's state changed (status, progress, plan, branch, summary); same payload as "conversation". */
  | { type: "task"; conversation: Conversation }
  /** A project was created or changed (module 06); archived ones come with `archived: true`. */
  | { type: "project"; project: Project }
  /** This device was renamed, or a paired device was paired, changed, went online or offline (module 07). */
  | { type: "device"; device: Device }
  | { type: "device-deleted"; deviceId: string }
  /** Something changed on a paired device: one of the events above, about its agents, chats or projects (module 07). */
  | { type: "remote"; deviceId: string; event: AppEvent }
  /** Memory repo (module 10): a memory repo changed. */
  | MemoryEvent;

// ---------------------------------------------------------------------------
// Computers (one per agent, created lazily on first tool use)
// ---------------------------------------------------------------------------

export type ComputerKind = "boat" | "local";
export type ComputerState = "starting" | "running" | "stopping" | "stopped" | "error";

export interface ComputerSummary {
  id: string;
  kind: ComputerKind;
  state: ComputerState;
  /** e.g. "Boat VM · 4 vCPU / 8 GB" or "Local workspace" */
  label: string;
  /** Provider-side id (Boat sandbox id). */
  externalId?: string;
  /** Browser URL for the VM's virtual desktop, when the backend supports it. */
  desktopUrl?: string;
  /** Local-backend working directory on this machine. */
  workspacePath?: string;
  exposedUrls: { port: number; url: string }[];
  /** The computer has a desktop the agent can see and control (Boat VMs). */
  gui: boolean;
  /** Latest screenshot the agent took of its desktop (image URL), for a live view. */
  screenshotUrl?: string;
  lastUsedAt?: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Memory: short facts about the user, shared by every agent. What an agent
// knows about its work lives in its workspace wiki (below).
// ---------------------------------------------------------------------------

export interface Memory {
  /**
   * 8 hex characters (6 in entries from before); "h" + 10 hex for a line someone wrote without an id; "<id>.2"
   * for a second line with the same id (two devices edited one entry), so each can be edited on its own (module 10).
   */
  id: string;
  content: string;
  /** Who wrote it: an agent (memory_save, Dreaming), or the user (the Memory page, or the file by hand). */
  source: "agent" | "user";
  conversationId: string | null;
  createdAt: number;
  updatedAt: number;
  /** The memory repo and file it's in (module 10), e.g. "you" and "MEMORY.md". */
  repo: MemoryRepoId;
  path: string;
}

// ---------------------------------------------------------------------------
// Brains: long-term knowledge bases, each a wiki of DeepWiki-style pages. They
// live at the app level, not inside an agent: every agent has a private
// "notebook" brain, and shared brains (one per repo, client, product…) are
// attached to the agents that need them, read-only or read-write — or to every
// agent at once. Agents read and write them with wiki_* tools; after a chat goes
// quiet a background "keeper" folds what was learned into them; the user can
// browse and edit them. Every brain has a pinned "Overview" page (can't be
// deleted) — for a repo brain, its start-here guide.
//
// Which brain a task is about is decided by plain signals rather than a model:
// a repo's name, URL or ~/repos/<name> path, an @name mention, or the brain's
// keywords. A matching brain's Overview is put in front of the agent, and the
// first one becomes the chat's focus (where new pages go by default).
// ---------------------------------------------------------------------------

export type BrainKind = "notebook" | "repo" | "notes";
export type BrainAccess = "read" | "write";

export interface Brain {
  id: string;
  name: string;
  kind: BrainKind;
  /** One line: what it knows and when to use it. Shown to agents as the brain's card. */
  description: string;
  /** Repo brains: the git URL or folder it was learned from. */
  source: string | null;
  /** Words that mean a request is about this brain (e.g. product or service names). */
  keywords: string[];
  /** A notebook's agent; only that agent sees it. Null for shared brains. */
  ownerAgentId: string | null;
  /** Every agent can read and write it, attached or not. */
  allAgents: boolean;
  /** Agents attached to it, and what they may do. */
  agents: { agentId: string; access: BrainAccess }[];
  pageCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface BrainInput {
  name: string;
  description?: string;
  keywords?: string[];
  allAgents?: boolean;
  /** Attach this agent (read-write) right away. */
  agentId?: string;
}

export type BrainPatch = Partial<Omit<BrainInput, "agentId">>;

export type WikiAuthor = "agent" | "keeper" | "user";

export interface WikiPageSummary {
  id: string;
  brainId: string;
  /** Parent page (pages nest, e.g. a repo page with Architecture under it); null at the top. */
  parentId: string | null;
  title: string;
  /** One line: what's on the page / when to read it. Shown in the page list and to the agent. */
  summary: string;
  /** Pinned pages (the Overview) go into every new chat in full. */
  pinned: boolean;
  /** Order among siblings (ascending). */
  position: number;
  /** Who last changed it: the agent during a chat, the keeper after a chat, or the user. */
  updatedBy: WikiAuthor;
  updatedAt: number;
  /** Module 11: this page heads a project repo's docs (its subtree is that repo's); the repo's name. */
  repo?: string | null;
}

export interface WikiPage extends WikiPageSummary {
  /** Markdown. ```mermaid blocks render as diagrams. */
  content: string;
  /** The chat that last changed it, if any. */
  conversationId: string | null;
  createdAt: number;
}

export interface WikiSearchHit extends WikiPageSummary {
  /** Matching excerpt; matched words are wrapped in «…». */
  snippet: string;
}

/** A page's state before a change (newest first), for history and restore. */
export interface WikiRevision {
  id: string;
  pageId: string;
  title: string;
  summary: string;
  content: string;
  updatedBy: WikiAuthor;
  conversationId: string | null;
  createdAt: number;
  /** Module 11: kept from before the wiki moved into git ("Before git"); newer versions come from git. */
  legacy?: boolean;
}

export interface WikiPageInput {
  title: string;
  summary?: string;
  content: string;
  parentId?: string | null;
}

export interface WikiPagePatch extends Partial<WikiPageInput> {
  position?: number;
}

/** Ask the agent to study a code repository and write it up as a brain of its own. */
export interface LearnRepoRequest {
  /** A git URL (e.g. https://github.com/acme/web) or a folder on the agent's computer. */
  source: string;
}

// ---------------------------------------------------------------------------
// GitHub: one account connected for the whole app. When connected, every agent
// gets GitHub's MCP tools (issues, pull requests, code search…) and its computer
// is logged in for git and the gh CLI, so it can clone private repos and work on
// tickets. Writes (pushing branches, opening PRs, commenting) are off until the
// user allows them; even then agents never merge or push to the default branch
// unless asked. The token itself never leaves the server.
// ---------------------------------------------------------------------------

export interface GitHubConnection {
  login: string;
  name: string | null;
  avatarUrl: string;
  /** How it was connected: the gh CLI login on this machine, a pasted token, or browser sign-in. */
  source: "cli" | "token" | "oauth";
  /** OAuth/classic token scopes, e.g. ["repo", "read:org"]; empty for fine-grained tokens. */
  scopes: string[];
  connectedAt: number;
}

export interface GitHubStatus {
  connection: GitHubConnection | null;
  /** Set when GitHub stopped accepting the saved token (revoked or expired): reconnect. */
  problem: string | null;
  /** Agents may push branches, open pull requests and comment. Off = read-only. */
  allowWrites: boolean;
  /** `gh` is logged in on this machine, so "Use GitHub CLI login" connects in one click. */
  cli: { login: string } | null;
  /** Browser sign-in is set up (TOT_GITHUB_CLIENT_ID in .env). */
  oauthAvailable: boolean;
}

export type GitHubConnectRequest = { method: "cli" } | { method: "token"; token: string };

/** Browser sign-in: show `userCode` and open `verificationUri`, then poll GET /api/github/device. */
export interface GitHubDeviceStart {
  userCode: string;
  verificationUri: string;
  expiresAt: number;
  intervalSeconds: number;
}

export interface GitHubDevicePoll {
  state: "pending" | "connected" | "expired" | "denied" | "none";
  status?: GitHubStatus;
}

export interface GitHubRepo {
  fullName: string;
  private: boolean;
  description: string | null;
  url: string;
  pushedAt: number | null;
}

// ---------------------------------------------------------------------------
// Apps: Gmail, Linear, Notion… connected once and shared by every agent, on both
// Claude and ChatGPT. Powered by Executor (open source, executor.sh), which TOT
// installs on request and runs privately on this machine. Executor keeps the
// credentials and its per-tool rules: reads run freely, while actions that change
// things pause the turn for the user's OK on an approval card (answer within a
// minute). Apps are added in Executor's own web UI (only reachable on this machine).
// ---------------------------------------------------------------------------

export interface AppsStatus {
  state: "not-installed" | "installing" | "starting" | "running" | "stopped" | "error";
  /** The Executor version installed, if any. */
  version: string | null;
  /** What went wrong (state "error"), in plain words. */
  error: string | null;
  /** Connected apps (Executor connections), when running. */
  apps: AppConnection[];
}

export interface AppConnection {
  id: string;
  /** The app this account belongs to (see AppCatalogItem.appId); one app can have several accounts. */
  appId: string;
  /** e.g. "Gmail". */
  name: string;
  iconUrl: string | null;
  /** Which account it's signed in as, e.g. "dhruval@gmail.com", when known. */
  account: string | null;
  /** False when the app needs attention (expired sign-in, missing permissions). */
  healthy: boolean;
}

/**
 * An app in TOT's catalog (from the public integrations.sh directory that Executor
 * also uses), or one already added.
 */
export interface AppCatalogItem {
  /** Stable id used by the /api/apps routes. */
  appId: string;
  name: string;
  description: string;
  iconUrl: string | null;
  /**
   * How connecting works: "sign-in" (one click, approve in a pop-up), "key" (paste an API
   * key), "client" (sign-in needing your own OAuth app first, e.g. Google), "none", or
   * "unknown" until TOT has looked closer.
   */
  connect: "sign-in" | "key" | "client" | "none" | "unknown";
  /** Connected accounts (0 = not connected). */
  accounts: number;
}

/** What to do next to connect an app (POST /api/apps/connect). */
export type AppConnectStep =
  | { step: "connected"; status: AppsStatus }
  /** Open `url` (a pop-up) and approve; then poll GET /api/apps/connect/:flowId. Only works in a browser on this machine. */
  | { step: "sign-in"; flowId: string; url: string }
  /** Ask for these values and POST /api/apps/connect again with { values }. */
  | { step: "key"; fields: AppKeyField[]; help: { label: string; url: string } | null }
  /**
   * The provider needs the user's own OAuth app: register `redirectUri` in its console,
   * POST /api/apps/oauth-client, then POST /api/apps/connect again.
   */
  | { step: "client"; provider: string; redirectUri: string; consoleUrl: string | null };

export interface AppKeyField {
  name: string;
  label: string;
  /** Fixed text sent before the value, e.g. "Bearer ". */
  prefix?: string;
}

export interface AppConnectRequest {
  appId: string;
  /** Answers to a "key" step. */
  values?: Record<string, string>;
}

export interface AppConnectPoll {
  state: "pending" | "connected" | "failed";
  error?: string;
}

/** One action an app offers and whether agents may use it freely, must ask first, or can't. */
export interface AppRule {
  /** The action's id within the app, e.g. "users.messages.send"; "*" is the whole app. */
  tool: string;
  description: string;
  action: "approve" | "require_approval" | "block";
  /** True when no rule is set and the app's default applies (reads run, writes ask). */
  isDefault: boolean;
}

// ---------------------------------------------------------------------------
// Slack: TOT's own Slack bot (a Slack app the user creates from TOT's manifest,
// connected over Socket Mode, so no public URL is needed). DM it or @mention it
// and an agent works on the request: each Slack thread becomes a TOT chat (with
// the thread so far as context), the answer is posted back in the thread, and
// approval requests become Approve/Deny buttons. Only people the user allowed
// can use it; others are listed as requests to allow. Pick an agent by starting
// the message with its name ("Puddin: …"); otherwise the default agent answers.
// ---------------------------------------------------------------------------

export interface SlackStatus {
  state: "not-set-up" | "connecting" | "connected" | "error";
  error: string | null;
  /** The Slack workspace's name, once connected. */
  workspace: string | null;
  /** The bot's name in Slack, e.g. "tot". */
  botName: string | null;
  /** The agent that answers when a message doesn't name one; null = the first agent. */
  defaultAgentId: string | null;
  /** People who may use TOT in Slack. */
  allowedUsers: SlackPerson[];
  /** People who tried and aren't allowed yet (newest first). */
  requests: SlackPerson[];
  /** TOT's Slack app manifest (JSON), to paste when creating the app. */
  manifest: string;
  /** Opens Slack's "create app" page with the manifest filled in. */
  createAppUrl: string;
}

export interface SlackPerson {
  id: string;
  name: string;
}

export interface SlackTokens {
  /** App-level token (xapp-…, scope connections:write) for Socket Mode. */
  appToken: string;
  /** Bot token (xoxb-…) from "Install to workspace". */
  botToken: string;
}

export interface SlackPatch {
  defaultAgentId?: string | null;
  /** Let a person use TOT (a Slack user id from `requests`). */
  allow?: string;
  /** Stop letting a person use TOT. */
  disallow?: string;
}

// ---------------------------------------------------------------------------
// Personas: an identity agents work as, so their work shows up as "Tot", not as
// the user. A persona has a name and a real mailbox (e.g. a Gmail account made
// for the agent, connected with an app password over IMAP/SMTP), and optionally
// its own GitHub account. An agent working as a persona can read, search and
// send email from that mailbox (sending asks the user first), wait for sign-up
// codes and magic links, commits as the persona on its computer, and uses the
// persona's GitHub account when one is connected. Emails from allowed senders
// become tasks: each email thread is a TOT chat and the answer is sent back as
// a reply; mail from anyone else is only stored for the agent to read. Several
// agents may share one persona.
// ---------------------------------------------------------------------------

export interface Persona {
  id: string;
  /** Sender name and git author, e.g. "Tot". */
  name: string;
  /** The mailbox's address, e.g. "tot.agent@gmail.com"; also the git author email. */
  email: string;
  /** Its picture (an uploaded image's URL); null shows its initials. */
  avatarUrl: string | null;
  mailbox: PersonaMailbox;
  /** The persona's own GitHub account; null = agents working as it have no GitHub access of their own. */
  github: PersonaGitHub | null;
  /** Addresses (lowercase) whose emails become tasks. Mail from anyone else is only stored. */
  allowedSenders: string[];
  /** The agent that takes emailed tasks; null = the first agent working as this persona. */
  defaultAgentId: string | null;
  /** Agents working as this persona. */
  agentIds: string[];
  /** Unread emails in the inbox. */
  unread: number;
  createdAt: number;
  updatedAt: number;
}

export interface PersonaMailbox {
  state: "not-connected" | "connecting" | "connected" | "error";
  error: string | null;
  /** e.g. "Gmail", or the IMAP host for other providers. */
  provider: string | null;
  imap: MailServer | null;
  smtp: MailServer | null;
  /** When new mail was last checked. */
  checkedAt: number | null;
}

export interface MailServer {
  host: string;
  port: number;
}

export interface PersonaGitHub {
  login: string;
  name: string | null;
  avatarUrl: string | null;
  /** Same rule as the app-wide connection: pushing branches and opening PRs only when on. */
  allowWrites: boolean;
  /** Why the token stopped working (revoked, expired), when it did. */
  problem: string | null;
}

export interface PersonaInput {
  name: string;
  email: string;
}

export interface PersonaPatch {
  name?: string;
  email?: string;
  /** An image uploaded with POST /api/uploads (PNG, JPEG, GIF or WebP, up to 5 MB); null removes the picture. */
  avatarId?: string | null;
  allowedSenders?: string[];
  defaultAgentId?: string | null;
}

export interface MailboxConnectRequest {
  /** An app password (Gmail: myaccount.google.com/apppasswords). Stored privately; never sent back. */
  password: string;
  /** The login name, when it isn't the email address. */
  username?: string;
  /** Server settings; detected from the address (Gmail, Outlook, iCloud, Yahoo, Fastmail, Zoho) when omitted. */
  imap?: MailServer;
  smtp?: MailServer;
}

export interface MailAddress {
  name: string | null;
  address: string;
}

export interface MailSummary {
  id: string;
  personaId: string;
  /** Emails in one conversation share this. */
  threadId: string;
  from: MailAddress;
  to: MailAddress[];
  subject: string;
  /** The start of the text, about 200 characters. */
  snippet: string;
  date: number;
  unread: boolean;
  /** Sent from the persona's address. */
  outgoing: boolean;
  /** Sign-in or verification codes found in it, e.g. ["482913"]. */
  codes: string[];
  hasAttachments: boolean;
}

export interface MailMessage extends MailSummary {
  cc: MailAddress[];
  /** Plain text (HTML emails are converted). */
  text: string;
  /** Links in it, e.g. "Verify your email" magic links. */
  links: { text: string; url: string }[];
  attachments: { name: string; size: number; contentType: string }[];
  /** The TOT chat this email started or continued, if any. */
  conversationId: string | null;
}

export interface PersonaGitHubConnectRequest {
  /** A token from the persona's GitHub account (classic with "repo", or fine-grained). Stored privately. */
  token: string;
}

// ---------------------------------------------------------------------------
// Plugins (MCP servers). TOT's own computer+memory server is built in and not listed.
// ---------------------------------------------------------------------------

export type PluginConfig =
  | { type: "http"; url: string; headers?: Record<string, string> }
  | { type: "stdio"; command: string; args?: string[]; env?: Record<string, string> };

export interface Plugin {
  id: string;
  /** MCP server name: lowercase slug, unique, e.g. "github" */
  name: string;
  description?: string;
  config: PluginConfig;
  enabled: boolean;
  /** Which providers receive this plugin. */
  providers: ProviderId[];
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export interface Settings {
  /** ModelOption id used for new chats. */
  defaultModelId: string;
  /** Your name, used in the system prompt. */
  userName: string;
  /** Like ChatGPT custom instructions; appended to every system prompt. */
  customInstructions: string;
  computer: {
    /** boat = cloud VM per chat, local = sandboxed folder on this machine, off = no computer tools */
    mode: "boat" | "local" | "off";
    boatApiKeySet: boolean;
    size: "small" | "default" | "large";
    /** Stop (snapshot) idle computers after this many minutes. */
    idleStopMinutes: number;
  };
  memory: {
    enabled: boolean;
    /** Memory repo (module 10): the nightly pass that tidies memory, at a local "HH:MM". */
    dreaming: { enabled: boolean; time: string };
    /** Memory repo (module 10): an optional private git remote the `you` repo is backed up to. Off by default. */
    remote: { url: string; enabled: boolean };
  };
  claude: {
    /** subscription = local Claude Code login; api-key = ANTHROPIC_API_KEY stored in TOT */
    authMode: "subscription" | "api-key";
    apiKeySet: boolean;
    /** Let Claude use the connectors (Gmail, Drive, …) connected to the claude.ai account. */
    useConnectedApps: boolean;
  };
  chatgpt: {
    /** Let Codex use the apps/connectors connected to the ChatGPT account, when supported. */
    useConnectedApps: boolean;
  };
  tasks: TaskSettings;
  /** Model tiers (module 02). */
  models: ModelTierSettings;
}

/** PATCH /api/settings body. Secrets are write-only and never returned. */
export type SettingsPatch = Partial<Omit<Settings, "computer" | "memory" | "claude" | "chatgpt" | "tasks" | "models">> & {
  models?: Partial<ModelTierSettings>;
  computer?: Partial<Omit<Settings["computer"], "boatApiKeySet">>;
  memory?: Partial<Omit<Settings["memory"], "dreaming" | "remote">> & {
    dreaming?: Partial<Settings["memory"]["dreaming"]>;
    remote?: Partial<Settings["memory"]["remote"]>;
  };
  claude?: Partial<Omit<Settings["claude"], "apiKeySet">>;
  chatgpt?: Partial<Settings["chatgpt"]>;
  tasks?: Partial<TaskSettings>;
  /** Set to "" to clear. */
  boatApiKey?: string;
  /** Set to "" to clear. */
  anthropicApiKey?: string;
};

// ---------------------------------------------------------------------------
// REST API (all JSON; errors are { error: string } with a 4xx/5xx status)
//
// GET    /api/health                          -> { ok: true, version: string }
// GET    /api/providers                       -> ProviderStatus[]
// GET    /api/models                          -> ModelOption[]   ("auto" first; then each enabled account's models)
// GET    /api/skills                          -> SkillInfo[]  (skills on this computer a message can invoke with "/name", by name)
// GET    /api/accounts                        -> AccountStatus[] (?refresh=1 re-checks sign-ins; never env values)
// POST   /api/accounts                        AccountInput -> ProviderAccount
// PATCH  /api/accounts/:id                    AccountPatch -> ProviderAccount
// DELETE /api/accounts/:id                    -> { ok: true }    (400 for a built-in account)
// POST   /api/accounts/:id/login              -> AccountLogin    (ChatGPT: a URL to open; Claude: a command to run)
// POST   /api/accounts/folders/pick           -> { path: string | null }  (macOS folder picker; this Mac only)
// GET    /api/accounts/import/t3              -> T3ImportCandidate[]  (reads T3 Code's settings, never writes them)
// POST   /api/accounts/import/t3              { ids: string[] } -> ProviderAccount[]
//
// GET    /api/agents                          -> Agent[]         (creation order; the default agent first)
// POST   /api/agents                          AgentInput -> Agent
// PATCH  /api/agents/:id                      Partial<AgentInput> -> Agent
// DELETE /api/agents/:id                      -> { ok: true }    (deletes its chats and computer; 400 for the last agent)
// POST   /api/agents/:id/computer/stop        -> ComputerSummary | null
// GET    /api/agents/:id/computer/desktop     -> 302 to a fresh desktop-stream URL (open in a new tab)
// GET    /api/agents/:id/computer/screens/:f  -> image/png (screenshots the agent took)
// GET    /api/agents/:id/routines             -> Routine[]
// POST   /api/agents/:id/routines             RoutineInput -> Routine
// PATCH  /api/routines/:id                    Partial<RoutineInput> -> Routine
// DELETE /api/routines/:id                    -> { ok: true }
// POST   /api/routines/:id/run                -> { conversationId, runId }   (run now)
//
// GET    /api/conversations[?agentId=&slim=1] -> Conversation[]  (updatedAt desc; slim=1: tasks trimmed to what lists show, `partial`)
// POST   /api/conversations                   CreateConversationRequest -> Conversation
// GET    /api/conversations/:id[?clip=1]      -> ConversationDetail  (clip=1: finished messages' tool parts carry the start of
//                                              their output and long input strings, marked `clipped`; a running reply comes
//                                              as it is now, with activeMessageId + activeRunSeq. ETag; If-None-Match -> 304)
// GET    /api/conversations/:id/messages/:messageId/parts/:partId -> MessagePart  (the whole part, e.g. a clipped tool call)
// PATCH  /api/conversations/:id               UpdateConversationRequest -> Conversation  (projectId moves it and its tasks)
// DELETE /api/conversations/:id               -> { ok: true }
// POST   /api/conversations/:id/messages      SendMessageRequest -> SendMessageResponse
//                                              (a task: steers it while it runs or waits in the queue — runId is then the
//                                              turn running, or "" — else picks it up again with this message.
//                                              A chat: its model answers, starting tasks itself when the work calls for it)
// POST   /api/conversations/:id/computer/stop -> ComputerSummary | null   (alias: the chat's agent's computer)
//
// Tasks (a task is a conversation with kind "task"; see TaskInfo)
// GET    /api/tasks[?agentId=&status=]        -> Conversation[]  (queued ones in queue order first, then newest first)
// POST   /api/tasks                           StartTaskRequest & { agentId?, projectId? } -> Conversation  (a top-level task; with a
//                                              requestId it started in the last hour: 200 and that task, nothing new)
// POST   /api/conversations/:id/tasks         StartTaskRequest -> Conversation  (started from this chat; its card shows there.
//                                              201; with a requestId it started before: 200 and that task, nothing new)
// POST   /api/conversations/:id/convert       ConvertToTaskRequest -> Conversation  (this chat becomes a task, transcript kept)
// POST   /api/conversations/:id/steer         SteerRequest -> Message  (the saved note; reaches a running task mid-turn or next turn)
// POST   /api/tasks/:id/pause                 -> Conversation  (interrupts the turn; resume continues it)
// POST   /api/tasks/:id/resume                -> Conversation  (queued again; starts when a slot is free)
// POST   /api/tasks/:id/stop                  -> Conversation  (the worktree and branch are kept)
// POST   /api/tasks/:id/run-now               -> Conversation  (front of the queue; starts now if a slot is free)
// POST   /api/tasks/:id/to-chat               -> { ok: true }  (a stopped, paused or finished task becomes a plain chat again)
// POST   /api/tasks/:id/continue-on           ContinueOnRequest -> Conversation  (module 02: writes a handoff, then carries on
//                                              in a fresh session on that provider; a finished task does so on its next message)
// PATCH  /api/tasks/:id                       TaskPatch -> Conversation  (rename, goal, position in the queue)
// POST   /api/agents/:id/queue/resume         -> Agent  (module 05: clears agent.queueHold; queued tasks start again)
// POST   /api/conversations/:id/fork          ForkRequest -> Conversation  (module 05: "Fork of …", its messages copied up to
//                                              messageId; its first turn continues the source's provider session natively when it can)
// POST   /api/conversations/:id/merge-back    -> Conversation  (module 05: a fork brings its new messages back to its source chat: a
//                                              notice there, and a note for its next turn; returns the source)
// GET    /api/conversations/:id/rewind?messageId=  -> RewindPreview  (what rewinding to one of the user's messages takes away)
// POST   /api/conversations/:id/rewind        RewindRequest -> RewindResponse  (that message and everything after it go; with
//                                              restoreFiles the chat's workspace files go back too; 409 while a reply runs)
// GET    /api/tasks/:id/changes               -> TaskChanges  (coding tasks: the branch's changes against its base)
// Module 09 · lane A (land a finished coding task; every change also goes out as a `task` event)
// GET    /api/tasks/:id/land                  -> TaskLandOptions  (worked out now: merge into the folder's checked-out branch, or a draft PR;
//                                              each with the reason it can't, e.g. uncommitted changes, a tot/* checkout, conflicts, writes off)
// POST   /api/tasks/:id/land                  LandTaskRequest -> Conversation  (409 with the reason when it can't. merge: TOT merges --no-ff in
//                                              your folder, then removes the worktree and the merged branch; pr: pushes the tot/* branch
//                                              from the worktree and opens a draft PR as the agent's account; the worktree stays)
// POST   /api/tasks/:id/update-from-base      -> Conversation  (rebases the branch onto its base in the worktree; on conflicts, or work left
//                                              uncommitted, the rebase is undone and the task gets a turn to do it: status "running")
// POST   /api/tasks/:id/discard               -> Conversation  (stops it, removes its worktree, deletes its branch unless it was pushed)
// POST   /api/tasks/:id/checks                -> Conversation  (runs the repo profile's gates on the branch again: checks "running", the
//                                              result arrives as a task event; "none" when the repo has no profile)
// DELETE /api/conversations/:id?deleteBranch=1  (a task: also removes its worktree; its branch only with deleteBranch, and only if never pushed)
//
// Mission control (module 09, lane B; TaskInfo.stats is refreshed after every turn and when a task finishes)
// GET    /api/mission[?projectId=&agentId=&group=]  -> MissionOverview  (open tasks, finished ones with code not yet landed,
//                                              and those landed or finished without code in the last day; with group: every task
//                                              in it. overlaps: other unlanded tasks on the same repo folder changing the same paths)
// POST   /api/tasks/best-of                   BestOfRequest -> Conversation[]  (one task per provider, pinned, in one "best-of"
//                                              group; 201, or 200 with a requestId it started before. They don't wake their chat
//                                              one by one: it gets one "Best of N finished" notice (notice.group) when all end)
//
// POST   /api/uploads                         multipart/form-data, field "file" (≤ 25 MB) -> Attachment
// GET    /api/uploads/:id/:name               -> the file
//
// GET    /api/events                          -> text/event-stream of AppEvent (app-wide)
// GET    /api/runs/live                       -> LiveRuns  (what runs and waits for the user right now; the phone app, module 14)
// GET    /api/runs/:runId/events[?after=]     -> text/event-stream of RunEvent  (after: skip events up to that seq, as
//                                              Last-Event-ID does; ConversationDetail.activeRunSeq says where a snapshot is)
// POST   /api/runs/:runId/stop                -> { ok: true }
// POST   /api/runs/:runId/approvals/:partId   ApprovalAnswer -> { ok: true }  (404 when it's no longer pending)
//
// GET    /api/brains                          -> Brain[]  (notebooks first, in agent order, then shared brains by name)
// POST   /api/brains                          BrainInput -> Brain
// PATCH  /api/brains/:id                      BrainPatch -> Brain  (a notebook can't be renamed or shared)
// DELETE /api/brains/:id                      -> { ok: true }  (400 for a notebook)
// PUT    /api/brains/:id/agents/:agentId      { access: BrainAccess } -> Brain
// DELETE /api/brains/:id/agents/:agentId      -> Brain
// GET    /api/brains/:id/wiki                 -> WikiPageSummary[]  (all pages; Overview first, then by parent/position)
// GET    /api/brains/:id/wiki?q=              -> WikiSearchHit[]    (best matches first)
// POST   /api/brains/:id/wiki                 WikiPageInput -> WikiPage
// POST   /api/agents/:id/wiki/learn           LearnRepoRequest -> { conversationId, runId, brainId }  (400 when the computer is off)
// GET    /api/wiki/:pageId                    -> WikiPage
// PATCH  /api/wiki/:pageId                    WikiPagePatch -> WikiPage
// DELETE /api/wiki/:pageId                    -> { ok: true }  (400 for a pinned page; children move up a level)
// GET    /api/wiki/:pageId/revisions          -> WikiRevision[]  (newest first)
// POST   /api/wiki/:pageId/revisions/:revisionId/restore -> WikiPage
//
// A project's knowledge (module 11, lane B): its wiki pages and memory facts in one git repo. The wiki routes above
// work the same on top of git; a page that brings in a secret is refused with 400.
// GET    /api/projects/:id/knowledge          -> KnowledgeStatus
// GET    /api/projects/:id/knowledge/history?limit=&skip= -> KnowledgeCommit[]  (newest first: facts and pages)
// POST   /api/projects/:id/knowledge/undo     { sha } -> KnowledgeCommit  (the undo commit; 409 when later changes touched the same lines)
//
// Memory repo (module 10; memory is git repos of markdown: "you" and "projects/<slug>"; paired devices may call
// only the sync bundle). Writes are one commit each; a secret is refused with 400.
// GET    /api/memories?q=&repo=               -> Memory[]  (repo defaults to "you"; file order, or best matches for q)
// POST   /api/memories                        { content, repo?, file? } -> Memory  (201; an existing equal entry: 200 and that one)
// PATCH  /api/memories/:id?repo=              { content, expected? } -> Memory  (409 when the entry no longer says `expected`)
// DELETE /api/memories/:id?repo=              -> { ok: true }
// GET    /api/memory/repos                    -> MemoryRepoSummary[]  ("you" first, then each project; sync status on "you")
// GET    /api/memory/:repo/files              -> MemoryFile[]  (:repo URL-encoded, e.g. projects%2Fweb; MEMORY.md first)
// GET    /api/memory/:repo/file?path=         -> MemoryFileContent  (404 when missing)
// GET    /api/memory/:repo/history?limit=&skip= -> MemoryCommit[]  (newest first)
// POST   /api/memory/:repo/revert             { sha } -> MemoryCommit  (the undo commit; 409 when later changes touched the same lines; 400 for a sync's merge)
// POST   /api/memory/import/:id               -> Memory  (imports an old memory the import left out as a secret; 400 for a key)
// DELETE /api/memory/import/:id               -> { ok: true }  (drops it for good)
// POST   /api/memory/dream                    MemoryDreamRequest -> { ok: true }  (202: runs in the background; a "memory" event when done)
// POST   /api/memory/sync                     -> MemorySyncStatus  (sync with paired devices and the backup remote now)
// GET    /api/memory/sync/you.bundle          -> application/octet-stream  (paired devices only: a git bundle of "you"; 403 for others)
//
// Knowledge auto-updates (module 11, lane C; after a task lands, when a repo's main branch moves, after chats, Dreaming;
// each run is one commit in the project's knowledge repo; paired devices get 403: knowledge stays on its device)
// GET    /api/projects/:id/knowledge/updates  -> KnowledgeUpdate[]  (newest first: runs in progress (running), then the last 50)
// POST   /api/projects/:id/knowledge/refresh  -> KnowledgeRefreshResult  (checks every repo's base branch now; an update is
//                                              queued for each that moved, and shows in `updates` as running)
// POST   /api/projects/:id/knowledge/updates/:updateId/undo -> KnowledgeUpdate  (reverts its commit through memory's undo and puts
//                                              its pages back; 409 when a page it wrote changed since, or later changes collide)
//
// GET    /api/github                         -> GitHubStatus
// POST   /api/github/connect                  GitHubConnectRequest -> GitHubStatus  (400 with the reason when it doesn't work)
// POST   /api/github/device                   -> GitHubDeviceStart  (browser sign-in; 400 when not set up)
// GET    /api/github/device                   -> GitHubDevicePoll   (poll every intervalSeconds until not "pending")
// PATCH  /api/github                          { allowWrites: boolean } -> GitHubStatus
// DELETE /api/github                          -> GitHubStatus  (disconnect; agents' computers are logged out on next use)
// GET    /api/github/repos?q=                 -> GitHubRepo[]  (the user's repos, recently pushed first; 400 when not connected)
//
// GET    /api/apps                            -> AppsStatus
// POST   /api/apps/setup                      -> AppsStatus  (installs Executor if needed, then starts it; follow "apps" events)
// POST   /api/apps/stop                       -> AppsStatus  (turns apps off until set up again)
// GET    /api/apps/access                     -> { onThisMachine: boolean }  (whether this browser can do sign-ins)
// GET    /api/apps/catalog?q=                 -> AppCatalogItem[]  (added apps first when q is empty)
// POST   /api/apps/connect                    AppConnectRequest -> AppConnectStep
// GET    /api/apps/connect/:flowId            -> AppConnectPoll
// DELETE /api/apps/connect/:flowId            -> { ok: true }  (cancel a sign-in)
// POST   /api/apps/oauth-client               { appId, clientId, clientSecret } -> { ok: true }
// DELETE /api/apps/:appId                     -> AppsStatus  (removes the app, its accounts and rules)
// GET    /api/apps/:appId/rules               -> AppRule[]   (the whole app first, then each action)
// PUT    /api/apps/:appId/rules               { tool, action: AppRule["action"] | "default" } -> AppRule[]
//
// GET    /api/slack                           -> SlackStatus
// PUT    /api/slack/tokens                    SlackTokens -> SlackStatus  (checks them with Slack and connects; 400 with the reason)
// PATCH  /api/slack                           SlackPatch -> SlackStatus
// DELETE /api/slack                           -> SlackStatus  (disconnects and forgets the tokens)
//
// GET    /api/personas                        -> Persona[]
// POST   /api/personas                        PersonaInput -> Persona
// PATCH  /api/personas/:id                    PersonaPatch -> Persona
// DELETE /api/personas/:id                    -> { ok: true }  (agents working as it go back to the user; forgets passwords, tokens and stored mail)
// PUT    /api/personas/:id/mailbox            MailboxConnectRequest -> Persona  (signs in over IMAP and SMTP; 400 with the reason)
// DELETE /api/personas/:id/mailbox            -> Persona  (disconnects and forgets the password)
// POST   /api/personas/:id/mailbox/refresh    -> Persona  (check for new mail now)
// GET    /api/personas/:id/mail?q=&limit=     -> MailSummary[]  (newest first; q searches sender, subject and text)
// GET    /api/personas/:id/mail/:mailId       -> MailMessage    (marks it read)
// PUT    /api/personas/:id/github             PersonaGitHubConnectRequest -> Persona  (checks the token with GitHub; 400 with the reason)
// PATCH  /api/personas/:id/github             { allowWrites: boolean } -> Persona
// DELETE /api/personas/:id/github             -> Persona
//
// GET    /api/plugins                         -> Plugin[]
// POST   /api/plugins                         PluginInput -> Plugin
// PATCH  /api/plugins/:id                     Partial<PluginInput> -> Plugin
// DELETE /api/plugins/:id                     -> { ok: true }
//
// GET    /api/settings                        -> Settings
// PATCH  /api/settings                        SettingsPatch -> Settings
//
// GET    /api/brains/:id/profile              -> RepoProfile | null  (null until one is saved; 400 for a brain that isn't a repo)
// PUT    /api/brains/:id/profile              RepoProfileInput -> RepoProfile  (also rewrites the brain's "Repo profile" page)
// POST   /api/brains/:id/profile/draft        { agentId? } -> RepoProfile  (not saved; drafted from the repo on that agent's computer)
// POST   /api/brains/:id/profile/run          { agentId?, command } -> CommandRun  ("Run now": one command in the repo's folder)
// GET    /api/playbooks                       -> Playbook[]  (built-ins first, then custom ones by name)
// POST   /api/playbooks                       PlaybookInput -> Playbook  (400 with the reason when a step is invalid)
// PATCH  /api/playbooks/:id                   PlaybookPatch -> Playbook  (built-ins take `enabled` only)
// DELETE /api/playbooks/:id                   -> { ok: true }  (400 for a built-in)
// POST   /api/playbooks/match                 { goal } -> PlaybookMatch
// GET    /api/workflows                       -> WorkflowSettings
// PATCH  /api/workflows                       Partial<WorkflowSettings> -> WorkflowSettings
// POST   /api/trust/check                     TrustCheckRequest -> GateReport   (dev only until tasks exist; 404 in production)
// POST   /api/trust/review                    TrustReviewRequest -> Review      (dev only until tasks exist; 404 in production)
//
// Projects (module 06; every agent can work in every project)
// GET    /api/projects[?archived=1]           -> Project[]  (name order; archived ones only with ?archived=1)
// GET    /api/projects/folders/recent         -> RecentFolder[]  (git repos one level under ~/code, ~/projects, ~/playground, ~/dev, ~/src, ~/Documents/GitHub; newest first, at most 12)
// POST   /api/projects                        CreateProjectRequest -> Project  (also makes or reuses its brain; 400 for a folder that can't be shared: ~, hidden top-level folders, ~/Library, TOT's data)
//                                              (module 12: with firstMessage, its Lead is opened and sent it as the user's once the project is ready, a folder once it's allowed)
// PATCH  /api/projects/:id                    UpdateProjectRequest -> Project
// DELETE /api/projects/:id                    -> Project  (archives it; its chats stay, filed under it)
// POST   /api/projects/:id/grant              -> Project  (folder projects: the user's OK for agents to read the folder and make tot/… branches in it)
// POST   /api/projects/:id/learn              { agentId } -> { conversationId, runId }  (Learn a repo into its brain; a folder project needs its grant and a local computer)
//
// A project's repos (module 11 · lane A; Project.repos lists them, the primary first)
// POST   /api/projects/:id/repos              AddProjectRepoRequest -> Project  (201; a GitHub repo is cloned at ~/projects/<slug>.<name>, a folder used in
//                                              place with its own grant; 409 for a repo or name the project has already)
// PATCH  /api/projects/:id/repos/:name        UpdateProjectRepoRequest -> Project  (rename: its tasks follow, its clone stays; primary: true makes it the primary)
// DELETE /api/projects/:id/repos/:name        -> Project  (409 while a task has work in it: still going, or a worktree not landed or discarded;
//                                              its clones and folder stay where they are)
// POST   /api/projects/:id/repos/:name/grant  -> Project  (folder repos: the user's OK for agents to read it and make tot/… branches in it)
//
// Worktree lifecycle (module 09 · lane C; a project's setupCommand and copyFiles go through PATCH /api/projects/:id)
// GET    /api/projects/:id/setup-detect       -> SetupDetection  (the setup command its lockfile implies, for the Worktree setup dialog)
// POST   /api/tasks/:id/preview/stop          -> Conversation  (stops the task's preview; TaskInfo.preview becomes null)
// POST   /api/worktrees/cleanup               -> { removed: number }  (removes worktrees of finished, unlanded tasks older than
//                                              tasks.worktreeCleanupDays now, as the daily sweep does; their branches stay)
//
// Workspaces (module 11 · lane D: a project's Lead, and Home)
// POST   /api/projects/:id/lead               { agentId? } -> Conversation  (the project's Lead chat, `lead: true`, pinned, titled "Lead":
//                                              made the first time (201) with agentId or the agent most active in the project, the
//                                              same one after (200); 400 for an archived project without one. Project.leadChatId names it)
// GET    /api/home                            -> HomeProject[]  (every project that isn't archived, the most recently active first:
//                                              what needs you, is working and is ready to land on its board, and its Lead chat)
//
// Coordinator (module 12 · lane A: what a project's Lead hears about on its own)
// GET    /api/projects/:id/signals[?limit=]   -> LeadSignal[]  (newest first, default 50, at most 100; readAt null = the Lead hasn't heard it yet)
// POST   /api/projects/:id/signals/check      -> LeadSignal[]  (looks at the project's pull requests now, then its signals as above; 409 with
//                                              the reason without a GitHub connection or a Lead, with watching off, or while GitHub's rate limit lasts)
// GET    /api/projects/:id/subscriptions      -> ProjectSubscriptions  (default { pullRequests: "tot" })
// PATCH  /api/projects/:id/subscriptions      UpdateProjectSubscriptionsRequest -> ProjectSubscriptions  (also on Project.subscriptions; watching
//                                              more starts a look at once)
//
// Coordinator (module 12 · lane B: a project's schedules, which run in its Lead as "schedule" signals, never a new chat)
// GET    /api/projects/:id/schedules          -> Routine[]  (projectId set; agents' routine lists leave them out)
// POST   /api/projects/:id/schedules          RoutineInput -> Routine  (201; runs with the Lead's agent, opening the Lead if there's none; 400 when archived)
// PATCH  /api/projects/:id/schedules/:rid     Partial<RoutineInput> -> Routine  (enabled: false pauses it; 404 for another project's)
// DELETE /api/projects/:id/schedules/:rid     -> { ok: true }
//
// Devices (module 07; this device, remote access, and the browsers and phones signed in to it)
// GET    /.well-known/tot                     -> { id, name, protocol: 1 }  (open, no sign-in: lets another device check it reached TOT)
// GET    /api/devices                         -> DevicesStatus
// PATCH  /api/devices/self                    RenameDeviceRequest -> DevicesStatus
// POST   /api/devices/pairing-link            -> { link, expiresAt }  (one-time, 5 minutes; a new one replaces the last; 400 when other devices can't reach this one)
// POST   /api/devices/connect                 ConnectDeviceRequest -> DevicesStatus & { deviceId, canReachYou }  (pairs both ways; 400/502 with the reason)
// PATCH  /api/devices/:id                     UpdateDeviceRequest -> DevicesStatus  (a new address is checked first)
// DELETE /api/devices/:id                     -> DevicesStatus  (unpairs on both sides; the other side is told when it can be reached)
// POST   /api/devices/unpaired                -> { ok: true }  (paired devices only: the caller unpaired this device)
// GET    /api/device-info                     -> { slack: { workspace, bot } | null, mailboxes: string[] }  (for a paired device's warnings)
// ALL    /api/d/:deviceId/<path>              -> the paired device's /api/<path>, streams included (502 when it's offline or refuses)
// POST   /api/pair                            PairRequest -> PairResponse  (open: device to device, with a live one-time code)
// GET    /pair                                -> a page saying where to paste the link (the code stays in the #fragment)
// PATCH  /api/access                         UpdateRemoteAccessRequest -> DevicesStatus  (400 without a password; 409 when set in .env)
// POST   /api/access/password                SetPasswordRequest -> DevicesStatus  (8+ characters; another device needs `current`, 403 when wrong; signs out every other browser)
// POST   /api/access/sign-in-link            SignInLinkRequest -> SignInLink  (one-time, 5 minutes; a new one replaces the last; 400 while remote access is off)
// POST   /api/access/check                   -> DevicesStatus  (looks at the network again now, e.g. after starting Tailscale)
// POST   /login                              form: password | token (legacy) | code (from a sign-in link) -> 302 with a session cookie
// POST   /login                              JSON AppSignInRequest -> AppSignInResponse  (the phone app, module 14: a session as a token,
//                                             sent as `Authorization: Bearer tots_…`; errors are { error } with 401 / 409 / 429)
// POST   /logout                              with that Bearer token -> { ok: true }  (signs the app out)
// GET    /api/sessions/current                -> { id: string | null }  (null for an access-token caller or with sign-in off)
// DELETE /api/sessions/:id                    -> DevicesStatus  (signs that browser out: its next request gets 401 and its event streams close)
// POST   /api/sessions/sign-out-others        -> DevicesStatus
// ---------------------------------------------------------------------------

export interface CreateConversationRequest {
  /** Defaults to the first agent. */
  agentId?: string;
  /** Defaults to the agent's modelId. */
  modelId?: string;
  /** Start the chat in this project (module 06). */
  projectId?: string | null;
  /** Where it works in a code project: its main checkout, or a new worktree of its own. Needs a code projectId. */
  workspace?: ChatWorkspaceMode;
}

export interface UpdateConversationRequest {
  title?: string;
  pinned?: boolean;
  modelId?: string;
  /** Move the chat into a project, or out of one with null (module 06). Its tasks move with it. */
  projectId?: string | null;
}

export interface ConversationDetail {
  conversation: Conversation;
  messages: Message[];
  /** Set while a turn is still running; attach to /api/runs/:id/events to follow it. */
  activeRunId: string | null;
  /**
   * With clip=1, while a turn runs: the reply's id, and the number of the run's last event its copy in `messages`
   * includes (that copy is the reply as it is now, not its last save). Follow the run from there
   * (/api/runs/:id/events?after=<activeRunSeq>) instead of replaying it from the start.
   */
  activeMessageId?: string;
  activeRunSeq?: number;
}

export interface SendMessageRequest {
  text: string;
  /** Ids of files uploaded with POST /api/uploads (max 10). */
  attachments?: string[];
  /** ModelOption id; defaults to the conversation's modelId. */
  modelId?: string;
  /** Force the strongest model + higher effort for this turn. */
  thinkHarder?: boolean;
  /** Other chats of the same agent attached as reference (module 05; at most 3). */
  contextChats?: string[];
  /**
   * A skill (GET /api/skills) to run this message with; the text may still start with "/name". Without it, a text
   * starting with "/name" of a known skill invokes it too, so any client can.
   */
  skill?: string;
}

export interface SendMessageResponse {
  runId: string;
  userMessage: Message;
  conversation: Conversation;
}

/** Where a skill was found: a Claude config folder's skills/, ~/.agents/skills, a Codex home's, or an enabled Claude plugin. */
export type SkillSource = "claude" | "codex" | "agents" | "plugin";

/** A skill a message can invoke ("/dh-stack fix the cart"): from its SKILL.md frontmatter only. */
export interface SkillInfo {
  /** What follows the slash; a plugin's skills are "plugin:skill", e.g. "voyager:make-image". */
  name: string;
  /** One line, at most about 200 characters. */
  description: string;
  source: SkillSource;
  pluginName?: string;
}

export interface PluginInput {
  name: string;
  description?: string;
  config: PluginConfig;
  enabled?: boolean;
  providers?: ProviderId[];
}

// ---------------------------------------------------------------------------
// Tasks (roadmap module 01). A task is a conversation (kind "task") that keeps
// working in the background until it's done: TOT sends turn after turn while it
// makes progress, it survives closed tabs and server restarts, and it waits in
// a per-agent queue when its agent is busy. The user can steer, pause, resume
// and stop it. A chat can start tasks (each shows as a live card in the chat,
// and the result is reported back there) or become one. A task with a repo is
// a coding task: it works on its own branch in its own git worktree on the
// agent's computer, so parallel tasks never collide. TOT never pushes it.
// ---------------------------------------------------------------------------

/**
 * queued → running → done | failed | stopped, with detours: needs-input (waiting for an
 * approval or an answer), paused (by the user), interrupted (the server restarted mid-run).
 */
export type TaskStatus = "queued" | "running" | "needs-input" | "paused" | "done" | "failed" | "stopped" | "interrupted";

export interface TaskPlanItem {
  text: string;
  done: boolean;
}

export interface TaskInfo {
  /** One or two sentences: what "done" means. Shown on cards. */
  goal: string;
  status: TaskStatus;
  /** The latest "what I'm doing" line, from the agent's task_update. */
  progress: string | null;
  /** The agent's checklist. */
  plan: TaskPlanItem[];
  /** What the task asked the user (status "needs-input" without a pending approval). */
  question: string | null;
  /** Null for tasks without code. */
  repo: TaskRepo | null;
  /** Place in its agent's queue (1 = next) while queued; null otherwise. */
  queuePosition: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  /** The result reported back to the chat that started it (or why it failed or stopped). */
  summary: string | null;
  /** Turns sent so far (TOT sends more while the task makes progress). */
  turns: number;
  usage: { inputTokens: number; outputTokens: number };
  // Orchestration (module 02).
  /** What this session is for; null for a task started without one. */
  role: Role | null;
  /** The model tier its turns use under TOT Auto; null = the strongest (deep). */
  tier: Tier | null;
  /** The provider it should run on (a reviewer on the other provider, a switch after a usage limit); null = Auto decides. */
  provider: ProviderId | null;
  /** Levels below the user's chat: 1 for a chat's task (or a top-level task), 2 for a task's own task. */
  depth: number;
  /** Tasks spawned together share a group; with `then: "synthesize"` the parent gets one writer turn once they've all finished. */
  group: string | null;
  then: "synthesize" | null;
  /** What it was asked to do, when another session started it. */
  brief: TaskBrief | null;
  /** Its structured result (from task_finish). */
  result: TaskResult | null;
  /** The latest handoff packet: what another session or provider needs to carry on without the transcript. */
  handoff: HandoffPacket | null;
  /** Paused for a usage limit: when it resumes by itself. */
  resumeAt: number | null;
  // Mission control (module 09). Optional: tasks from before 09 don't have them.
  /** Lines changed on its branch, refreshed after every turn. */
  stats?: TaskDiffStats | null;
  /** The project's test gates (module 03) on its branch. */
  checks?: TaskChecks | null;
  /** Merged into your folder, opened as a PR, or discarded. */
  landing?: TaskLanding | null;
  /** What its `group` is: tasks split from one job, or the same job on several providers. */
  groupKind?: TaskGroupKind | null;
  /** Its worktree's setup command (npm ci, …). */
  setup?: TaskSetup | null;
  /** Its port block on its computer. */
  ports?: TaskPorts | null;
  /** Its running preview (a dev server TOT manages). */
  preview?: TaskPreview | null;
  /**
   * Set on tasks in a slim chat list (GET /api/conversations?slim=1): of `brief` only the goal, of `result` the summary,
   * first three findings and sources, and no `handoff`. The task's own load and its live events carry it whole.
   */
  partial?: boolean;
}

export interface TaskRepo {
  /** GitHub "owner/name", a clone URL, or a folder on the agent's computer. */
  source: string;
  /** Where the repo lives on the computer: its project's folder (~/projects/<slug>, or a folder on this Mac), ~/repos/<name> outside a project, or the folder itself. */
  folder: string;
  /** e.g. "main". */
  baseBranch: string;
  /** "tot/<slug>-<4 chars>". */
  branch: string;
  /** <folder>/.tot-worktrees/<branch slug>: the task's own checkout, its working directory. */
  worktree: string;
  /** The branch's newest commit, recorded after every turn; null before the worktree exists. */
  headSha: string | null;
  /** Module 11: which of the project's repos it works in (its name); null outside a project or in a one-repo project before 11. */
  repoName?: string | null;
}

// ---------------------------------------------------------------------------
// Mission control (module 09): many coding tasks on one project, landed from TOT
// ---------------------------------------------------------------------------

/** A task's branch against where it left its base: committed and uncommitted changes, untracked files counted. */
export interface TaskDiffStats {
  files: number;
  added: number;
  removed: number;
  /** Changed paths, at most 200. */
  paths: string[];
  headSha: string | null;
  at: number;
}

export type TaskChecksState = "running" | "passing" | "failing" | "none";

/** Module 03's gates on the task's branch: when it finishes, and on demand. "none" = the repo has no profile yet. */
export interface TaskChecks {
  state: TaskChecksState;
  /** One line per gate, e.g. "typecheck passed", "test failed: 3 of 214". */
  lines: string[];
  headSha: string | null;
  at: number;
}

export type TaskLandingKind = "merged" | "pr" | "discarded";

export interface TaskLanding {
  kind: TaskLandingKind;
  at: number;
  /** The branch it was merged into, or the PR's base; null when discarded. */
  target: string | null;
  /** The merge commit (merged) or the pushed head (pr). */
  sha: string | null;
  pr: { number: number; url: string } | null;
}

/** How a finished task can land right now (GET /api/tasks/:id/land). */
export interface TaskLandOptions {
  /** Folder projects: merge into the branch checked out in your folder, done by TOT on your click. */
  merge: { available: boolean; target: string | null; reason: string | null };
  /** GitHub projects with GitHub writes on: push the tot/* branch and open a draft PR. */
  pr: { available: boolean; base: string; reason: string | null };
  /** Commits on the base since the branch left it. */
  behind: number;
}

export interface LandTaskRequest {
  method: "merge" | "pr";
  /** PR only: overrides for the generated title and body. */
  title?: string;
  body?: string;
  /** The head the user reviewed (task.repo.headSha): refused with a 409 when the branch is somewhere else now. */
  headSha?: string;
}

/** The worktree's setup command, run once when the worktree is created. */
export interface TaskSetup {
  state: "running" | "done" | "failed" | "skipped";
  /** What ran: the project's setupCommand, or one detected from a lockfile. */
  command: string | null;
  at: number;
  /** The last lines of output when it failed. */
  error: string | null;
}

/** GET /api/projects/:id/setup-detect: what new worktrees would run with no setupCommand set (null: no lockfile found, or none to look at). */
export interface SetupDetection {
  command: string | null;
  lockfile: string | null;
}

/** A block of ports on the task's computer: PORT = base, TOT_PORTS = base..base+count-1. */
export interface TaskPorts {
  base: number;
  count: number;
}

/** A dev server TOT runs for the task (task_preview_start), stopped when the task lands or is discarded. */
export interface TaskPreview {
  url: string;
  port: number;
  command: string;
  startedAt: number;
}

export type TaskGroupKind = "parallel" | "best-of";

/** Two unlanded tasks on the same repo changing the same files. */
export interface MissionOverlap {
  taskId: string;
  paths: string[];
}

export interface MissionTask {
  conversation: Conversation;
  overlaps: MissionOverlap[];
}

/** GET /api/mission: open tasks, finished ones not yet landed, and those landed in the last day. */
export interface MissionOverview {
  tasks: MissionTask[];
  /** Finished, unlanded task ids in the order to land them: fewest overlaps first, then the smallest. */
  landOrder: string[];
}

/** The same job on several providers, each in its own worktree, compared side by side. */
export interface BestOfRequest {
  /** The chat it's started from (its project and repo are used); or agentId + projectId from a project page. */
  conversationId?: string;
  agentId?: string;
  projectId?: string | null;
  title?: string;
  goal: string;
  /** One task per entry; defaults to every logged-in provider (two runs when only one is). */
  providers?: ProviderId[];
  requestId?: string;
}

// ---------------------------------------------------------------------------
// Workspaces (module 11): a project's repos, one knowledge base, a Lead, Home
// ---------------------------------------------------------------------------

export type ProjectRepoKind = "github" | "folder";

/** One repo of a project: a GitHub repo cloned on each agent's computer, or a folder on this Mac used in place. */
export interface ProjectRepo {
  /** Unique within the project, e.g. "web"; names its tasks' repo and its docs in the knowledge base. */
  name: string;
  kind: ProjectRepoKind;
  /** "owner/name" (or a git URL) for github; an absolute path for folder. */
  source: string;
  /** The branch tasks start from; null = the repo's own default. */
  defaultBranch: string | null;
  /** Folder repos: the user allowed agents to work in the folder. Always true for github. */
  folderGranted: boolean;
  /** The project's main repo: keeps the project's original checkout, and tasks default to it. */
  primary: boolean;
}

export interface AddProjectRepoRequest {
  kind: ProjectRepoKind;
  source: string;
  /** Defaults to the repo's or folder's name, made unique in the project. */
  name?: string;
  defaultBranch?: string | null;
  /** Folder repos: the user already said yes to the consent dialog. */
  grant?: boolean;
}

export interface UpdateProjectRepoRequest {
  name?: string;
  defaultBranch?: string | null;
  /** true makes it the primary (the old primary keeps its checkout). */
  primary?: boolean;
}

/** Where a project's knowledge (wiki pages and memory facts) lives, and whether its move to git is done. */
export interface KnowledgeStatus {
  projectId: string;
  /** Its knowledge repo, e.g. "projects/web" (module 10's repo id). */
  repo: string;
  /** The repo's folder on this Mac, "~/.tot/memory/projects/web". */
  path: string;
  /** git: pages and facts live in the repo; database: the move to git hasn't happened or failed (pages still work from the database). */
  state: "git" | "moving" | "database";
  error: string | null;
  pages: number;
  facts: number;
}

/** One change in a project's knowledge, facts and pages alike (newest first): a commit of its knowledge repo. */
export interface KnowledgeCommit extends MemoryCommit {
  /** The wiki pages it changed (empty for a change to facts only). */
  pages: { id: string; title: string; action: "created" | "edited" | "moved" | "deleted" | "restored" | "imported" }[];
}

export type KnowledgeTrigger = "landed" | "base-moved" | "chat" | "dreaming" | "manual";

/** One auto-update of a project's knowledge: what triggered it, and what it changed (one commit). */
export interface KnowledgeUpdate {
  id: string;
  projectId: string;
  trigger: KnowledgeTrigger;
  repoName: string | null;
  taskId: string | null;
  at: number;
  /** The commit, to undo it; null when nothing changed or it failed. */
  sha: string | null;
  pages: { id: string; title: string; action: "created" | "updated" }[];
  facts: number;
  /** One line for the UI: "Updated after “Fix cart”". */
  summary: string;
  error: string | null;
  /** Lane C: still running, or waiting to try again (`error` says why); not in the log yet. */
  running?: boolean;
  /** Lane C: when Undo put its changes back; null while they stand. */
  undoneAt?: number | null;
}

/** POST /api/projects/:id/knowledge/refresh: the project's repos checked now, how many had moved (an update runs for each), and the log. */
export interface KnowledgeRefreshResult {
  checked: number;
  moved: number;
  updates: KnowledgeUpdate[];
}

/** A project's row on Home: what needs you, what's working, what's ready to land, and its Lead. */
export interface HomeProject {
  project: Project;
  needsYou: number;
  working: number;
  readyToLand: number;
  lastActivityAt: number | null;
  leadChatId: string | null;
}

// ---------------------------------------------------------------------------
// Coordinator (module 12): the Lead hears about pull requests, tickets and schedules on its own
// ---------------------------------------------------------------------------

/** Which pull requests a project's Lead hears about: none, the draft PRs TOT opened for its tasks, or every open PR in its GitHub repos. */
export type PullRequestWatch = "off" | "tot" | "all";

export interface ProjectSubscriptions {
  pullRequests: PullRequestWatch;
}

export type UpdateProjectSubscriptionsRequest = Partial<ProjectSubscriptions>;

export type LeadSignalKind =
  | "ci-failed"
  | "ci-passed"
  | "changes-requested"
  | "review-comment"
  | "comment"
  | "pr-merged"
  | "pr-closed"
  | "pr-conflict"
  | "ticket"
  | "schedule";

/** Something a project's Lead heard about on its own (GET /api/projects/:id/signals); unread until its turn has seen it. */
export interface LeadSignal {
  id: string;
  projectId: string;
  kind: LeadSignalKind;
  /** One line, e.g. "Checks failed on draft PR #12 “Fix cart”". */
  title: string;
  /** More: the failing checks, a comment's first lines, a ticket's text, a schedule's prompt. */
  detail: string | null;
  url: string | null;
  repoName: string | null;
  taskId: string | null;
  prNumber: number | null;
  at: number;
  readAt: number | null;
}

export interface StartTaskRequest {
  /** Defaults to a short title made from the goal. */
  title?: string;
  goal: string;
  /** Orchestration (module 02): what the session is for, its tier, and a provider to prefer. */
  role?: Role;
  tier?: Tier;
  provider?: ProviderId;
  /** GitHub "owner/name", a git URL, or a folder on the agent's computer; omit for a task without code. */
  repo?: string;
  /** Defaults to the repo's default branch. */
  baseBranch?: string;
  /** ModelOption id; defaults to the chat's (or the agent's) model. */
  modelId?: string;
  /** Started from a chat: any id (≤ 100 characters); sending it again returns the task it started (module 05). */
  requestId?: string;
}

export interface ConvertToTaskRequest {
  /** Defaults to the chat's title. */
  goal?: string;
  repo?: string;
  baseBranch?: string;
}

export interface TaskPatch {
  title?: string;
  goal?: string;
  /** 1 = next in its agent's queue (queued tasks only). */
  queuePosition?: number;
}

export interface SteerRequest {
  text: string;
}

/** A coding task's changes: its worktree (committed or not) against where its branch left the base. */
/**
 * GET /api/tasks/:id/plan: the task's own plan, a markdown file the agent keeps on its computer (outside the repo,
 * so it's never committed). `content` is null when there's none yet, or when the computer is off (`reason` says).
 */
export interface TaskPlan {
  /** Where it is on the agent's computer, e.g. "~/tot-tasks/<task id>/PLAN.md". */
  path: string;
  content: string | null;
  reason: string | null;
}

export interface TaskChanges {
  baseBranch: string;
  branch: string;
  headSha: string | null;
  files: TaskChangedFile[];
  /** Unified diff of every file, cut short on huge changes (see `truncated`). */
  patch: string;
  truncated: boolean;
}

export interface TaskChangedFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
}

export interface TaskSettings {
  /** Tasks one agent runs at once (one computer each). */
  perAgentLimit: number;
  /** When a running task's provider hits its usage limit: write a handoff and carry on with the other one (else pause until the reset). */
  switchProviders: boolean;
  /** Tasks one chat or task may start. */
  maxChildren: number;
  /** Tasks running at once across all agents. */
  globalLimit: number;
  /** After a restart, pick tasks that were running back up by themselves. */
  resumeInterrupted: boolean;
  /** Also DM this Slack person when a task finishes or needs input; null = don't. */
  notifySlackUserId: string | null;
  /** A chat picks up its tasks' results and replies on its own when they finish, instead of on the user's next message (module 05). */
  wakeChats: boolean;
  /** Worktrees of finished tasks that weren't landed are removed this many days after they finished (branches stay); 0 = never (module 09). */
  worktreeCleanupDays: number;
}

// ---------------------------------------------------------------------------
// Orchestration (roadmap module 02). TOT decides how to run each request:
// answer inline, pass it to a running task, or spawn sessions — each with a
// role and a model tier (fast / standard / deep) — and combine their results.
// Work moves between sessions and providers through handoff packets, so a
// task can carry on with the other provider when one hits its usage limit.
// ---------------------------------------------------------------------------

export type Tier = "fast" | "standard" | "deep";

/**
 * What a session is for: explorer (reads and answers where/how), planner (writes the plan),
 * implementer (makes the change), tester (writes and runs tests), reviewer (reviews, on the
 * other provider), researcher (searches and reads, non-coding), writer (combines results).
 */
export type Role = "explorer" | "planner" | "implementer" | "tester" | "reviewer" | "researcher" | "writer";

export interface ModelTierSettings {
  /** The model for each tier on each provider (provider-native ids); null = TOT's default for that tier. */
  tiers: Record<Tier, Record<ProviderId, string | null>>;
  /** The tier each role runs on by default. */
  roles: Record<Role, Tier>;
  /** The account TOT Auto and tasks use for each provider (Provider accounts); the built-in one by default. */
  accounts: Record<ProviderId, string>;
}

/** What a child session gets instead of the parent's transcript. */
export interface TaskBrief {
  goal: string;
  constraints: string[];
  /** Brain pages, files and links worth reading first. */
  context: string[];
  /** What "done" means. */
  done: string;
}

/** What a child session reports back, besides its summary. */
export interface TaskResult {
  summary: string;
  findings: string[];
  filesChanged: string[];
  openQuestions: string[];
  confidence: "low" | "medium" | "high";
  sources: string[];
}

/** Everything another session or provider needs to carry on, without the transcript. */
export interface HandoffPacket {
  goal: string;
  /** Concise and factual. */
  doneSoFar: string[];
  decisions: { decision: string; why: string }[];
  plan: TaskPlanItem[];
  files: { path: string; change: string }[];
  repo?: { branch: string; headSha: string; worktree: string };
  tests: { command: string; status: "pass" | "fail" | "not-run"; note?: string }[];
  openQuestions: string[];
  nextStep: string;
  from: { provider: ProviderId; model: string };
  createdAt: number;
}

export interface ContinueOnRequest {
  provider: ProviderId;
}

// ---------------------------------------------------------------------------
// Trust gates & playbooks (module 03, apps/server/trust/). Coding work proves itself
// before anyone sees a PR: each repo brain has a profile saying what "correct"
// means there (its own commands, conventions, protected paths and limits);
// gates run those commands and check the diff's scope, with failures that
// already exist on the base branch not counting; a fresh model, on the other
// provider by default, reviews the diff; and playbooks are the checklists a
// task follows step by step.
// ---------------------------------------------------------------------------

export type RepoCommandName = "install" | "typecheck" | "lint" | "test" | "testFile" | "build" | "e2e";

export interface RepoLimits {
  maxChangedLines: number;
  maxChangedFiles: number;
  allowNewDependencies: boolean;
  /** Each command is stopped after this long. */
  commandTimeoutMinutes: number;
}

/** What "correct" means for one repo. Stored per repo brain; drafted from its code, editable by the user. */
export interface RepoProfile {
  brainId: string;
  /** Run in the repo's folder on the agent's computer; missing = not used. `testFile` takes a {file} placeholder. */
  commands: Partial<Record<RepoCommandName, string>>;
  /** Short rules, e.g. "Use the Result type for errors, never throw in handlers". */
  conventions: string[];
  /** Globs agents must not change without asking, e.g. "migrations/**", ".github/**". */
  protectedPaths: string[];
  /** e.g. "Tests for new behaviour", "Docs updated for public APIs". */
  definitionOfDone: string[];
  limits: RepoLimits;
  updatedAt: number;
  updatedBy: "agent" | "user";
}

/** PUT /api/brains/:id/profile body. */
export type RepoProfileInput = Pick<RepoProfile, "commands" | "conventions" | "protectedPaths" | "definitionOfDone" | "limits">;

/** One command run on the agent's computer ("Run now"); output is clipped and scrubbed of secrets. */
export interface CommandRun {
  command: string;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
  outputTail: string;
}

export type GateName = "typecheck" | "lint" | "test" | "build" | "e2e" | "repro" | "scope" | "deps" | "size" | "review";

/**
 * A check with a pass/fail result. Hard gates (commands, protected paths) block the next
 * step; soft ones (diff size, new dependencies, files outside the plan) ask the user.
 */
export interface GateResult {
  gate: GateName;
  status: "pass" | "fail" | "skipped" | "needs-approval";
  command?: string;
  exitCode?: number;
  /** The last ~4 KB of output, secrets scrubbed. */
  outputTail?: string;
  /** The same check on the base branch. */
  baseline?: "pass" | "fail";
  /** When the check fails on the base branch too: failures it doesn't have. None = nothing new, so it doesn't block. */
  newFailures?: string[];
  durationMs?: number;
  note?: string;
  /** What's behind a finding: files outside the plan, protected paths touched, new dependencies, skipped tests. */
  details?: string[];
}

export interface GateReport {
  /** Nothing blocks and nothing waits for the user's OK. */
  ok: boolean;
  results: GateResult[];
  at: number;
  headSha: string | null;
  /** Where the branch left the base (merge-base), which the baseline was taken on. */
  baseSha: string | null;
}

export interface ReviewFinding {
  file: string;
  line?: number;
  severity: "must-fix" | "should-fix" | "nit";
  issue: string;
  suggestion?: string;
}

/** An independent verdict on a diff, from a fresh session that never saw the work being done. */
export interface Review {
  verdict: "approve" | "changes-requested";
  findings: ReviewFinding[];
  summary: string;
  reviewer: { provider: ProviderId; model: string };
}

export type PlaybookStepKind =
  | "understand"
  | "reproduce"
  | "plan"
  | "approve-plan"
  | "implement"
  | "verify"
  | "review"
  | "fix-loop"
  | "summarize"
  | "custom";

export interface PlaybookStep {
  id: string;
  kind: PlaybookStepKind;
  /** What the agent is told for this step. */
  instructions: string;
  /** Checks that must pass after the step. */
  gates?: GateName[];
  /** fix-loop only: rounds before asking the user. */
  maxRounds?: number;
}

/** An ordered list of steps with gates: a task is matched to one, and it becomes the task's checklist. */
export interface Playbook {
  id: string;
  name: string;
  description: string;
  /** Hints for choosing it automatically: "bug", "fix", "crash", "feature", "refactor"… */
  match: string[];
  steps: PlaybookStep[];
  builtIn: boolean;
  enabled: boolean;
}

/** POST /api/playbooks body (a custom playbook). */
export type PlaybookInput = Pick<Playbook, "name" | "description" | "match" | "steps"> & { enabled?: boolean };

/** PATCH /api/playbooks/:id body. Built-ins only take `enabled`; duplicate them to edit. */
export type PlaybookPatch = Partial<PlaybookInput>;

export interface PlaybookMatch {
  playbook: Playbook;
  /** Its match hints, the fast-tier classifier, or the fallback when neither decided. */
  by: "hints" | "classifier" | "fallback";
}

/** Settings → Workflows defaults. */
export interface WorkflowSettings {
  /** Stop for the user's OK on the plan before implementing. */
  requirePlanApproval: boolean;
  /** "other" = the provider that didn't write the code. */
  reviewer: "other" | ProviderId;
  /** Fix rounds after failed checks or a review before asking the user. */
  maxFixRounds: number;
}

/** POST /api/trust/check body (dev only until tasks exist): check any repo folder on the agent's computer. */
export interface TrustCheckRequest {
  agentId: string;
  /** The repo's folder, relative to the computer's home, e.g. "repos/web". */
  cwd: string;
  baseRef: string;
  /** The plan, whose cited paths are the files it may change. */
  plan?: string;
  /** Defaults to every command gate the repo's profile has, plus scope, deps and size. */
  gates?: GateName[];
}

/** POST /api/trust/review body (dev only until tasks exist). */
export interface TrustReviewRequest {
  agentId: string;
  cwd: string;
  baseRef: string;
  plan?: string;
  /** Who wrote the code; the reviewer is the other provider unless Settings → Workflows picks one. */
  implementedBy?: ProviderId;
}

// ---------------------------------------------------------------------------
// Coordination (roadmap module 05). A chat is woken when its tasks finish;
// a provider switch carries only the context that fits; task starts are
// retry-safe; nothing ends silently (a provider that keeps failing pauses
// its agent's queue); chats can be forked, merged back and attached.
// ---------------------------------------------------------------------------

/** A paused task queue: the next queued task waits until the user resumes it. */
export interface QueueHold {
  /** The provider that kept failing, when known. */
  provider: ProviderId | null;
  /** Its last error. */
  reason: string;
  createdAt: number;
}

/** Where a forked chat came from: its messages up to `messageId` were copied at `at`. */
export interface ForkOrigin {
  conversationId: string;
  messageId: string;
  at: number;
}

/** POST /api/conversations/:id/fork; without a message, the whole chat. */
export interface ForkRequest {
  messageId?: string;
}

/** POST /api/conversations/:id/rewind: back to before `messageId`, one of the user's messages. */
export interface RewindRequest {
  messageId: string;
  /** Also put the chat's workspace files back as they were before then (when RewindPreview.files). */
  restoreFiles?: boolean;
}

export interface RewindPreview {
  /** How many messages would go: this one and every one after it. */
  messages: number;
  /** The chat's workspace was checkpointed in those turns, so its files can go back too. */
  files: boolean;
}

export interface RewindResponse {
  conversation: Conversation;
  /** The message rewound to, for the composer to edit and send again. */
  draft: { text: string; attachments: Attachment[]; contextChats: string[] };
  filesRestored: boolean;
}

// ---------------------------------------------------------------------------
// Projects (roadmap module 06): what you work on, shared by every agent
// ---------------------------------------------------------------------------

/** A GitHub repo, a folder on this Mac (used in place, with consent), or a topic with no files. */
export type ProjectKind = "github" | "folder" | "none";

/** Where a project's work comes from (module 06 M4): tickets from these start their chat in it. */
export interface ProjectIntake {
  /** Slack channel names, e.g. "#web-bugs". */
  slackChannels: string[];
  /** Linear team keys, e.g. "ENG". */
  linearTeams: string[];
}

export interface Project {
  id: string;
  name: string;
  /** Its folder name: ~/projects/<slug> on an agent's computer. Unique, and kept when the project is renamed. */
  slug: string;
  kind: ProjectKind;
  /** "owner/name" (or a git URL) for github; an absolute path for folder; null for none. */
  source: string | null;
  /** The branch tasks start from; null means the repo's own default. */
  defaultBranch: string | null;
  /** The user's standing instructions for work in this project. */
  instructions: string;
  /** Its wiki: a repo brain for code projects, a notes brain for topics. */
  brainId: string;
  intake: ProjectIntake;
  /** Folder projects: the user allowed agents to work in the folder. */
  folderGranted: boolean;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  /** Chats and tasks in it, from every agent. */
  chats: number;
  /** Its tasks that are queued or running. */
  running: number;
  /** Set by the client for another device's project: the paired device it's on (module 07). */
  deviceId?: string;
  /** Run in every new task worktree (module 09): null = detect from the lockfile, "" = nothing. */
  setupCommand?: string | null;
  /** Folder projects: files copied from the folder into each new worktree, e.g. ".env". */
  copyFiles?: string[];
  /** Module 11: its repos, the primary first (`kind`, `source` and `folderGranted` mirror the primary). Empty for a topic project. */
  repos?: ProjectRepo[];
  /** Module 11: its Lead chat, once created. */
  leadChatId?: string | null;
  /** Module 12: what the Lead hears about on its own (default { pullRequests: "tot" }). */
  subscriptions?: ProjectSubscriptions;
}

export interface CreateProjectRequest {
  kind: ProjectKind;
  /** Required for github ("owner/name" or a URL) and folder (an absolute path, or one starting with ~). */
  source?: string;
  /** Defaults to the repo's or folder's name; required for kind "none". */
  name?: string;
  /** Folder projects: the user already said yes to the consent dialog (else POST /api/projects/:id/grant later). */
  grant?: boolean;
  /** Module 12: what you want built first; sent to the project's Lead once the project is ready (a folder: once it's allowed). */
  firstMessage?: string;
  /** Module 12: the agent whose Lead it goes to when the project has none yet (default: as POST /api/projects/:id/lead picks). */
  agentId?: string | null;
}

/** A git folder on this Mac, offered by the New project picker. */
export interface RecentFolder {
  /** Its real absolute path. */
  path: string;
  /** "~/playground/meet-notes". */
  label: string;
}

export interface UpdateProjectRequest {
  name?: string;
  instructions?: string;
  defaultBranch?: string | null;
  intake?: Partial<ProjectIntake>;
  /** Module 09: see Project.setupCommand and Project.copyFiles. */
  setupCommand?: string | null;
  copyFiles?: string[];
}

// ---------------------------------------------------------------------------
// Devices (roadmap module 07): computers running TOT, and the browsers and phones signed in to them
// ---------------------------------------------------------------------------

export interface Device {
  /** Made once per TOT install; never changes. */
  id: string;
  /** "Mac mini". Defaults to the computer's name; the user can rename it. */
  name: string;
  /** Where another computer or a phone opens TOT, e.g. "http://100.101.4.2:5173". Null when TOT only serves this machine. */
  address: string | null;
  /** What `address` goes over: Tailscale (works anywhere, encrypted) or the home network. */
  network: "tailscale" | "lan" | null;
  /** The device this screen is signed in to. */
  self: boolean;
  /** This device can reach it right now (its live event stream is up). */
  online: boolean;
  /** It can reach this device: it has its own event stream open to us. When false, pairing only works one way. */
  canReachUs: boolean;
  lastSeenAt: number | null;
  /** When it was paired with this device; null for this device. */
  pairedAt: number | null;
  /** Why it can't be used, e.g. "MacBook doesn't accept this device anymore. Pair them again." */
  problem: string | null;
  /** Things to fix that aren't errors, e.g. both devices answering the same Slack workspace. */
  warnings: string[];
}

/** A browser or phone signed in to this device. */
export interface SignInSession {
  id: string;
  /** "Safari on iPhone", "Chrome on this Mac". */
  label: string;
  /** The browser asking. */
  current: boolean;
  createdAt: number;
  lastSeenAt: number;
}

export interface DevicesStatus {
  self: Device;
  /** Devices paired with this one (from M2). */
  devices: Device[];
  /** Sign-in is set up (a password, or the legacy TOT_ACCESS_TOKEN). Until it is, only this computer can open TOT. */
  signIn: boolean;
  /** Newest first; empty until sign-in is set up. */
  sessions: SignInSession[];
  /** Remote access: whether, and how, phones and other computers reach this device. */
  access: RemoteAccess;
}

/** How other devices reach this one: not at all, over Tailscale (from anywhere), or on this network only. */
export type RemoteAccessMode = "off" | "tailscale" | "lan";

export interface RemoteAccess {
  mode: RemoteAccessMode;
  /** Fixed by .env (legacy), so the app's switch can't change it. */
  setBy: "TOT_LAN" | "TOT_HOST" | null;
  /** A password is set. It can be changed, never removed. */
  passwordSet: boolean;
  /** TOT_ACCESS_TOKEN in .env also signs in (legacy). */
  envToken: boolean;
  /** The browser asking is on this computer: it never needs to sign in, and may reset the password. */
  onThisMachine: boolean;
  /** This computer's Tailscale address, or null when Tailscale isn't running. */
  tailscaleAddress: string | null;
  /** Where other devices open TOT right now (Tailscale first); empty while remote access is off. */
  addresses: { url: string; network: "tailscale" | "lan" | null }[];
  /** Why remote access isn't working, e.g. "Tailscale isn't running on this computer." */
  problem: string | null;
}

export interface UpdateRemoteAccessRequest {
  mode: RemoteAccessMode;
}

export interface SetPasswordRequest {
  password: string;
  /** Needed from another device; this computer may set a new one without it. */
  current?: string;
}

export interface SignInLinkRequest {
  /** One of `RemoteAccess.addresses`; defaults to the first. */
  address?: string;
}

/** A one-time link that signs a phone in: shown as a QR code, it works once, for 5 minutes. */
export interface SignInLink {
  url: string;
  expiresAt: number;
}

export interface ConnectDeviceRequest {
  /** The pairing link from the other device: its address plus a one-time code, e.g. http://100.101.4.2:5173/pair#K7QM-4RXP-2HWD. */
  link: string;
}

export interface UpdateDeviceRequest {
  /** Where to reach it now. Omit to just try reaching it again. */
  address?: string;
}

export interface RenameDeviceRequest {
  /** An empty name goes back to the computer's own name. */
  name: string;
}

// ---------------------------------------------------------------------------
// Memory repo (roadmap module 10): memory as git repos of markdown, following the Agent Memory Repo spec.
// "you" holds what the user told any agent; "projects/<slug>" what agents learned in a project. Each is a
// folder of markdown files (MEMORY.md loaded every chat, topic files linked from it) under
// DATA_DIR/memory, one git commit per change. The `you` repo syncs with paired devices.
// ---------------------------------------------------------------------------

/** "you", or "projects/<slug>". */
export type MemoryRepoId = string;

/** A change to a memory repo is published so open screens (and paired devices, for `you`) catch up. */
export interface MemoryEvent {
  type: "memory";
  repo: MemoryRepoId;
  /** The repo's new head. */
  sha: string | null;
}

export type MemoryCommitKind = "start" | "import" | "remember" | "edit" | "forget" | "undo" | "dream" | "sync" | "backup" | "outside";

/** One commit in a memory repo's history. */
export interface MemoryCommit {
  sha: string;
  /** Who made it: an agent's name, "you", "Dreaming", "Sync", "TOT". */
  actor: string;
  kind: MemoryCommitKind;
  subject: string;
  /** Details (what Dreaming merged and why, what a sync brought in); "" when there are none. */
  body: string;
  at: number;
  /** Lines added and removed. */
  added: number;
  removed: number;
  /** False for the repo's first commit and for merges (a sync, the backup remote), which can't be undone. */
  revertible: boolean;
}

export interface MemoryDreamState {
  running: boolean;
  lastAt: number | null;
  /** "Merged 3, removed 2, added 1", or why the last dream changed nothing. */
  summary: string | null;
  /** The dream's commit, to undo it; null when it changed nothing. */
  sha: string | null;
  error: string | null;
}

export interface MemoryPeerSync {
  deviceId: string;
  name: string;
  online: boolean;
  lastSyncAt: number | null;
  /** null until the first try. */
  ok: boolean | null;
  error: string | null;
  /** Both changed and that device merges the two (it has the smaller id): since when this one has waited for it. */
  waitingSince: number | null;
}

export interface MemoryRemoteStatus {
  url: string;
  enabled: boolean;
  lastPushAt: number | null;
  lastPullAt: number | null;
  error: string | null;
}

export interface MemorySyncStatus {
  peers: MemoryPeerSync[];
  remote: MemoryRemoteStatus;
}

export interface MemoryRepoSummary {
  id: MemoryRepoId;
  kind: "you" | "project";
  /** "About you", or the project's name. */
  name: string;
  projectId: string | null;
  /** Where it is on this computer, e.g. "~/.tot/memory/you". */
  path: string;
  entries: number;
  files: number;
  lastCommit: MemoryCommit | null;
  dream: MemoryDreamState;
  /** The `you` repo only: paired devices and the optional backup remote. */
  sync: MemorySyncStatus | null;
  /** The `you` repo only: the one-time import of the memories from before module 10. */
  import: MemoryImportStatus | null;
}

/** An old memory the import left out because it looked like a secret. */
export interface MemorySkippedMemory {
  id: string;
  /** Its text, with what looks like the secret hidden. */
  text: string;
  createdAt: number;
  /** False when it holds a key: that can only be dropped. */
  importable: boolean;
}

export interface MemoryImportStatus {
  /** The import commit landed. Until then prompts and /api/memories read the old memories (read-only). */
  done: boolean;
  /** Why the last try failed; it's tried again at the next start. */
  error: string | null;
  skipped: MemorySkippedMemory[];
}

/** A file in a memory repo, with its entries (markdown files only). */
export interface MemoryFile {
  path: string;
  markdown: boolean;
  chars: number;
  entries: Memory[];
}

export interface MemoryFileContent {
  path: string;
  content: string;
}

export interface MemoryDreamRequest {
  /** One repo; omit for every repo that changed since its last dream. */
  repo?: MemoryRepoId;
}

// ---------------------------------------------------------------------------
// Provider accounts
//
// Several sign-ins per provider, like T3 Code's provider instances: a Claude
// account is a Claude Code config folder (CLAUDE_CONFIG_DIR: its login, the
// `env` block of its settings.json — e.g. a CCS proxy — and its MCP servers),
// a ChatGPT account a Codex home (CODEX_HOME). Two built-in accounts, "claude"
// and "chatgpt", use the default folders; every older provider id is one of them.
// ---------------------------------------------------------------------------

export interface ProviderAccount {
  /** "claude" / "chatgpt" for the built-ins; a slug of the name otherwise ("claude-mix"). Never contains ":". */
  id: string;
  driver: ProviderId;
  name: string;
  /** The config folder ("~/.claude-t3-ccs"); null = the driver's default (~/.claude, ~/.codex). */
  configDir: string | null;
  /** A specific CLI to run (an absolute path); null = the one TOT ships with. */
  binaryPath: string | null;
  /** Also give agents this account's own MCP servers (and, for Claude, its enabled plugins). */
  useAccountTools: boolean;
  enabled: boolean;
  builtIn: boolean;
}

export interface AccountStatus extends ProviderAccount {
  /** The folder it uses, "~/…" for home; the driver's default folder when configDir is null. */
  dir: string;
  dirExists: boolean;
  installed: boolean;
  loggedIn: boolean;
  /** e.g. "Claude Max subscription", "ChatGPT Pro plan", "Through a proxy". */
  authMethod?: string;
  /** Non-secret hint: the signed-in email, when known. */
  email?: string;
  /** How to sign in, or the last error. */
  detail?: string;
  /** Names of the keys in the folder's settings.json `env` (Claude). Values never leave the server. */
  envKeys: string[];
  /** ANTHROPIC_BASE_URL is set there: Claude Code talks to a proxy (e.g. CCS). */
  proxy: boolean;
  /** The account's own MCP servers (names), given to agents when useAccountTools is on. */
  mcpServers: string[];
  /** Its enabled Claude Code plugins (names), loaded when useAccountTools is on. */
  plugins: string[];
  models: ModelOption[];
  /** TOT Auto and tasks use this account for its provider (Settings → Models). */
  isDefault: boolean;
  /** Its usage-limit cooldown, when one is running. */
  limitedUntil: number | null;
}

export interface AccountInput {
  driver: ProviderId;
  name: string;
  configDir: string | null;
  binaryPath?: string | null;
  useAccountTools?: boolean;
}

export type AccountPatch = Partial<Pick<ProviderAccount, "name" | "configDir" | "binaryPath" | "useAccountTools" | "enabled">>;

export type AccountLogin = { kind: "url"; url: string } | { kind: "command"; command: string };

/** A provider instance in T3 Code's settings that TOT could add as an account. */
export interface T3ImportCandidate {
  /** Its key in T3 Code's providerInstances. */
  t3Id: string;
  driver: ProviderId;
  name: string;
  configDir: string;
  binaryPath: string | null;
  /** An account with this folder exists already. */
  alreadyAdded: boolean;
}

// ---------------------------------------------------------------------------
// Mobile app (roadmap module 14): a native client of one TOT; it signs in like a phone browser, with a token
// ---------------------------------------------------------------------------

export interface AppSignInRequest {
  client: "mobile";
  /** The one-time code from Settings → Devices → Add a phone (the `#code=` of its link)… */
  code?: string;
  /** …or the password set there. */
  password?: string;
  /** The phone's name, for the sign-in list ("TOT app on <deviceName>"). */
  deviceName?: string;
}

export interface AppSignInResponse {
  /** "tots_<session>": send it as `Authorization: Bearer <token>`. Signed out in Settings → Devices like a browser. */
  token: string;
  /** The TOT device it signed in to, e.g. "Mac mini". */
  deviceName: string;
}

/** GET /api/runs/live: what's running and waiting right now, for a screen that just opened (app events only tell changes). */
export interface LiveRuns {
  /** Turns in flight; follow one at /api/runs/:runId/events. */
  running: { runId: string; conversationId: string; agentId: string }[];
  /** Chats with a request waiting for the user: a tool's approval in a running turn, or a Lead's land / discard / push card. */
  waiting: { conversationId: string; agentId: string }[];
}
