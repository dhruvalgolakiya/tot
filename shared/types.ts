// Contracts shared by the TOT server (server/) and web client (src/).
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
  /** "auto" | "<provider>:<model>", e.g. "claude:claude-opus-5-5", "chatgpt:gpt-5.5" */
  id: string;
  provider: ProviderId | "auto";
  /** Provider-native model id ("claude-opus-5-5"), or "auto". */
  model: string;
  label: string;
  description?: string;
  available: boolean;
  unavailableReason?: string;
}

export interface ProviderStatus {
  id: ProviderId;
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

export interface Agent {
  id: string;
  name: string;
  mascot: MascotSpec;
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
}

export interface AgentInput {
  name: string;
  mascot: MascotSpec;
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
}

export interface RoutineInput {
  name: string;
  prompt: string;
  schedule: RoutineSchedule;
  enabled?: boolean;
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
}

export type ConversationKind = "chat" | "task";

export interface ConversationOrigin {
  kind: "slack" | "email";
  /** e.g. "#eng", "DM with Dhruval" or "Email from Dhruval". */
  label: string;
  /** Link to the Slack thread, when known (null for email). */
  url: string | null;
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
 *  - TOT memory:    memory_save, memory_search, memory_update, memory_delete (about the user)
 *  - TOT wiki:      wiki_search, wiki_read, wiki_write, wiki_edit, wiki_delete
 *  - TOT chats:     chat_search, chat_read (earlier chats in the same workspace)
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
    }
  | {
      type: "notice";
      id: string;
      kind: "memory" | "wiki" | "computer" | "route" | "info" | "warning";
      text: string;
      /** For "wiki": the pages that changed, so the UI can link to them. */
      pageIds?: string[];
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
  /** How TOT decided to handle this user message (module 02): answered here, sent to a task, or spawned tasks. */
  dispatch?: Dispatch;
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
  /** Terminal event. `message` is the final persisted assistant message. */
  | { type: "run-end"; status: MessageStatus; message: Message };

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
  | { type: "task"; conversation: Conversation };

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
  id: string;
  content: string;
  /** Who wrote it: the agent via memory_save, or the user in the Memory page. */
  source: "agent" | "user";
  conversationId: string | null;
  createdAt: number;
  updatedAt: number;
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
  memory?: Partial<Settings["memory"]>;
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
// GET    /api/models                          -> ModelOption[]   ("auto" first)
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
// GET    /api/conversations[?agentId=]        -> Conversation[]  (updatedAt desc)
// POST   /api/conversations                   CreateConversationRequest -> Conversation
// GET    /api/conversations/:id               -> ConversationDetail
// PATCH  /api/conversations/:id               UpdateConversationRequest -> Conversation
// DELETE /api/conversations/:id               -> { ok: true }
// POST   /api/conversations/:id/messages      SendMessageRequest -> SendMessageResponse
//                                              (a task: steers it while it runs or waits in the queue — runId is then the
//                                              turn running, or "" — else picks it up again with this message.
//                                              A chat: TOT decides (module 02; `mode` overrides): answers here, or passes the
//                                              message to a running task or starts tasks — runId "" — with the decision on
//                                              userMessage.dispatch)
// POST   /api/conversations/:id/computer/stop -> ComputerSummary | null   (alias: the chat's agent's computer)
//
// Tasks (a task is a conversation with kind "task"; see TaskInfo)
// GET    /api/tasks[?agentId=&status=]        -> Conversation[]  (queued ones in queue order first, then newest first)
// POST   /api/tasks                           StartTaskRequest & { agentId? } -> Conversation  (a top-level task)
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
// GET    /api/tasks/:id/changes               -> TaskChanges  (coding tasks: the branch's changes against its base)
// DELETE /api/conversations/:id?deleteBranch=1  (a task: also removes its worktree; its branch only with deleteBranch, and only if never pushed)
//
// POST   /api/uploads                         multipart/form-data, field "file" (≤ 25 MB) -> Attachment
// GET    /api/uploads/:id/:name               -> the file
//
// GET    /api/events                          -> text/event-stream of AppEvent (app-wide)
// GET    /api/runs/:runId/events              -> text/event-stream of RunEvent
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
// GET    /api/memories?q=                     -> Memory[]  (memory about the user)
// POST   /api/memories                        { content } -> Memory
// PATCH  /api/memories/:id                    { content } -> Memory
// DELETE /api/memories/:id                    -> { ok: true }
//
// GET    /api/github                          -> GitHubStatus
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
// ---------------------------------------------------------------------------

export interface CreateConversationRequest {
  /** Defaults to the first agent. */
  agentId?: string;
  /** Defaults to the agent's modelId. */
  modelId?: string;
}

export interface UpdateConversationRequest {
  title?: string;
  pinned?: boolean;
  modelId?: string;
}

export interface ConversationDetail {
  conversation: Conversation;
  messages: Message[];
  /** Set while a turn is still running; attach to /api/runs/:id/events to follow it. */
  activeRunId: string | null;
}

export interface SendMessageRequest {
  text: string;
  /** Ids of files uploaded with POST /api/uploads (max 10). */
  attachments?: string[];
  /** ModelOption id; defaults to the conversation's modelId. */
  modelId?: string;
  /** Force the strongest model + higher effort for this turn. */
  thinkHarder?: boolean;
  /** Chats: let TOT decide (default), answer here, or run it as a task. */
  mode?: DispatchMode;
}

export interface SendMessageResponse {
  runId: string;
  userMessage: Message;
  conversation: Conversation;
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
}

export interface TaskRepo {
  /** GitHub "owner/name", a clone URL, or a folder on the agent's computer. */
  source: string;
  /** Where the repo lives on the computer: ~/repos/<name> (as Learn a repo does), or the folder itself. */
  folder: string;
  /** e.g. "main". */
  baseBranch: string;
  /** "tot/<slug>-<4 chars>". */
  branch: string;
  /** <folder>/.tot-worktrees/<branch slug>: the task's own checkout, its working directory. */
  worktree: string;
  /** The branch's newest commit, recorded after every turn; null before the worktree exists. */
  headSha: string | null;
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
  /** Tokens one mission (a chat's tasks and their tasks) may use in all; 0 = no limit. */
  missionTokenBudget: number;
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

export type DispatchMode = "auto" | "inline" | "task";

export interface SpawnSession {
  role: Role;
  title: string;
  goal: string;
  tier: Tier;
  provider?: ProviderId;
  repo?: string;
}

/** TOT's decision for one user message, kept on it and shown as a chip ("Auto → 2 tasks"). */
export type Dispatch = (
  | { mode: "inline"; tier: Tier }
  | { mode: "continue-task"; taskId: string }
  | { mode: "spawn"; sessions: SpawnSession[]; then?: "synthesize"; taskIds: string[] }
) & {
  reason: string;
  /** A rule, the classifier, or the user's own choice in the composer. */
  by: "rule" | "classifier" | "user";
};

export interface ContinueOnRequest {
  provider: ProviderId;
}

// ---------------------------------------------------------------------------
// Trust gates & playbooks (module 03, server/trust/). Coding work proves itself
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
