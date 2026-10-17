import type {
  AccountInput,
  AccountLogin,
  AccountPatch,
  AccountStatus,
  T3ImportCandidate,
  AddProjectRepoRequest,
  Brain,
  BrainAccess,
  BrainInput,
  BrainPatch,
  Agent,
  AgentInput,
  AppCatalogItem,
  AppConnectPoll,
  AppConnectRequest,
  AppConnectStep,
  ApprovalAnswer,
  AppRule,
  AppsStatus,
  Attachment,
  BestOfRequest,
  ChatFiles,
  ComputerSummary,
  Conversation,
  ContinueOnRequest,
  PlanUsage,
  QueuedMessage,
  SendNowResult,
  ConversationDetail,
  ForkRequest,
  CreateConversationRequest,
  CreateProjectRequest,
  ConnectDeviceRequest,
  DevicesStatus,
  RemoteAccessMode,
  SetPasswordRequest,
  SignInLink,
  SignInLinkRequest,
  GitHubConnectRequest,
  GitHubDevicePoll,
  GitHubDeviceStart,
  GitHubRepo,
  GitHubStatus,
  HomeProject,
  KnowledgeRefreshResult,
  KnowledgeUpdate,
  LandTaskRequest,
  LeadSignal,
  LearnRepoRequest,
  MailMessage,
  MailSummary,
  Memory,
  KnowledgeCommit,
  KnowledgeStatus,
  MemoryCommit,
  MemoryFile,
  MemoryFileContent,
  MemoryRepoSummary,
  MemorySyncStatus,
  Message,
  MessagePart,
  MissionOverview,
  ModelOption,
  MailboxConnectRequest,
  Persona,
  PersonaGitHubConnectRequest,
  PersonaInput,
  PersonaPatch,
  Plugin,
  PluginInput,
  Project,
  ProjectSubscriptions,
  ProviderAccount,
  ProviderId,
  ProviderStatus,
  Routine,
  RoutineInput,
  SendMessageRequest,
  SendMessageResponse,
  SkillInfo,
  Settings,
  SettingsPatch,
  SetupDetection,
  SlackPatch,
  SlackStatus,
  SlackTokens,
  StartTaskRequest,
  TaskChanges,
  TaskPlan,
  TaskLandOptions,
  TaskPatch,
  TaskStatus,
  UpdateConversationRequest,
  UpdateDeviceRequest,
  UpdateRemoteAccessRequest,
  UpdateProjectRequest,
  UpdateProjectRepoRequest,
  UpdateProjectSubscriptionsRequest,
  WikiPage,
  WikiPageInput,
  WikiPagePatch,
  WikiPageSummary,
  WikiRevision,
  WikiSearchHit,
} from "@tot/shared/types";
import { adopt, apiUrl, deviceFor, deviceOf } from "./devices";

/** A failed API call. `status` is 0 when the server couldn't be reached at all. */
export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

const UNREACHABLE = "Can't reach the TOT server. Is it running?";

/**
 * The server wants sign-in (an access token is set and this browser has no valid
 * session, e.g. it expired): go to its login page and come back here afterwards.
 */
export function redirectToSignIn(): void {
  if (window.location.pathname === "/login") return;
  window.location.assign(`/login?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
type Ok = { ok: true };

async function request<T>(method: Method, path: string, body?: unknown): Promise<T> {
  // Decided before the first await: `onDevice` pins the device only while the call starts.
  const device = deviceFor(path, body);
  let response: Response;
  try {
    response = await fetch(apiUrl(path, device), {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(UNREACHABLE, 0);
  }

  if (response.status === 401) redirectToSignIn();
  const data = parseBody(await response.text());
  if (!response.ok) throw new ApiError(serverError(data, response.status), response.status);
  return (device ? adopt(device, data) : data) as T;
}

/**
 * A GET that names the copy the caller already has (its ETag): null when the server answers 304 (unchanged), else the
 * data and its new ETag. The browser's own cache stays out of it, so the 304 arrives here instead of a stored copy
 * this would have to parse again.
 */
async function requestIfChanged<T>(path: string, etag: string | null): Promise<{ data: T; etag: string | null } | null> {
  const device = deviceFor(path);
  let response: Response;
  try {
    response = await fetch(apiUrl(path, device), { cache: "no-store", headers: etag ? { "If-None-Match": etag } : undefined });
  } catch {
    throw new ApiError(UNREACHABLE, 0);
  }
  if (response.status === 304 && etag) return null;
  if (response.status === 401) redirectToSignIn();
  const data = parseBody(await response.text());
  if (!response.ok) throw new ApiError(serverError(data, response.status), response.status);
  return { data: (device ? adopt(device, data) : data) as T, etag: response.headers.get("etag") };
}

function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function serverError(data: unknown, status: number): string {
  if (data && typeof data === "object" && "error" in data && typeof data.error === "string" && data.error) {
    return data.error;
  }
  // The dev proxy answers with an empty 5xx when the backend is down.
  if (status >= 500 && !data) return UNREACHABLE;
  return `Request failed (${status})`;
}

/** Human-readable message for anything thrown by an API call. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "Something went wrong.";
}

const seg = encodeURIComponent;

export const api = {
  health: () => request<{ ok: true; version: string }>("GET", "/health"),
  /** `refresh` asks the server to re-check login state instead of using its cache. */
  listProviders: ({ refresh = false } = {}) =>
    request<ProviderStatus[]>("GET", refresh ? "/providers?refresh=1" : "/providers"),
  /** Starts a browser login (ChatGPT only for now); open the returned URL in a new tab. */
  loginProvider: (id: ProviderId) => request<{ url: string }>("POST", `/providers/${seg(id)}/login`, {}),
  listModels: () => request<ModelOption[]>("GET", "/models"),
  /** Skills a message can invoke with "/name" (from their SKILL.md frontmatter). */
  listSkills: () => request<SkillInfo[]>("GET", "/skills"),

  /** Provider accounts: several Claude / ChatGPT sign-ins. `refresh` re-checks every sign-in. */
  listAccounts: ({ refresh = false } = {}) => request<AccountStatus[]>("GET", refresh ? "/accounts?refresh=1" : "/accounts"),
  addAccount: (input: AccountInput) => request<ProviderAccount>("POST", "/accounts", input),
  updateAccount: (id: string, patch: AccountPatch) => request<ProviderAccount>("PATCH", `/accounts/${seg(id)}`, patch),
  deleteAccount: (id: string) => request<{ ok: true }>("DELETE", `/accounts/${seg(id)}`),
  /** ChatGPT: a sign-in page to open; Claude: a command to run in a terminal. */
  loginAccount: (id: string) => request<AccountLogin>("POST", `/accounts/${seg(id)}/login`, {}),
  pickAccountFolder: () => request<{ path: string | null }>("POST", "/accounts/folders/pick", {}),
  t3ImportCandidates: () => request<T3ImportCandidate[]>("GET", "/accounts/import/t3"),
  importFromT3: (ids: string[]) => request<ProviderAccount[]>("POST", "/accounts/import/t3", { ids }),

  listAgents: () => request<Agent[]>("GET", "/agents"),
  createAgent: (input: AgentInput) => request<Agent>("POST", "/agents", input),
  updateAgent: (id: string, input: Partial<AgentInput>) =>
    request<Agent>("PATCH", `/agents/${seg(id)}`, input),
  deleteAgent: (id: string) => request<Ok>("DELETE", `/agents/${seg(id)}`),
  stopAgentComputer: (id: string) =>
    request<ComputerSummary | null>("POST", `/agents/${seg(id)}/computer/stop`, {}),
  /** Opens (302s) to a fresh desktop-stream URL; call this to get a same-origin link to open in a new tab. */
  agentDesktopUrl: (id: string) => apiUrl(`/agents/${seg(id)}/computer/desktop`, deviceOf(id)),

  /** Tasks come trimmed to what lists show (`task.partial`); a task's own load and its live events have it whole. */
  listConversations: (agentId?: string) =>
    request<Conversation[]>("GET", agentId ? `/conversations?agentId=${seg(agentId)}&slim=1` : "/conversations?slim=1"),
  createConversation: (body: CreateConversationRequest) =>
    request<Conversation>("POST", "/conversations", body),
  /**
   * Finished tool calls come clipped (`clipped`; getConversationPart has one whole), a running reply as it is now.
   * With the ETag of the copy already loaded: null when the chat hasn't changed since.
   */
  getConversation: (id: string, etag: string | null = null) =>
    requestIfChanged<ConversationDetail>(`/conversations/${seg(id)}?clip=1`, etag),
  getConversationPart: (conversationId: string, messageId: string, partId: string) =>
    request<MessagePart>("GET", `/conversations/${seg(conversationId)}/messages/${seg(messageId)}/parts/${seg(partId)}`),
  updateConversation: (id: string, body: UpdateConversationRequest) =>
    request<Conversation>("PATCH", `/conversations/${seg(id)}`, body),
  /** Tasks: `deleteBranch` also deletes the task's branch, if it was never pushed. */
  deleteConversation: (id: string, opts: { deleteBranch?: boolean } = {}) =>
    request<Ok>("DELETE", `/conversations/${seg(id)}${opts.deleteBranch ? "?deleteBranch=1" : ""}`),
  sendMessage: (id: string, body: SendMessageRequest) =>
    request<SendMessageResponse>("POST", `/conversations/${seg(id)}/messages`, body),
  /** Files for the composer's "@": in the chat's working folder, or (a chat not sent yet) its project's. */
  listChatFiles: (id: string, query: string, limit?: number) =>
    request<ChatFiles>("GET", `/conversations/${seg(id)}/files?q=${seg(query)}${limit ? `&limit=${limit}` : ""}`),
  listProjectFiles: (projectId: string, agentId: string | null, query: string, limit?: number) =>
    request<ChatFiles>("GET", `/projects/${seg(projectId)}/files?q=${seg(query)}${agentId ? `&agentId=${seg(agentId)}` : ""}${limit ? `&limit=${limit}` : ""}`),
  /** Plan limits each provider account last reported (5-hour, weekly), by account id. */
  planUsage: () => request<Record<string, PlanUsage>>("GET", "/plan-usage"),
  /** The composer's queue: messages sent while the chat's turn runs. */
  listQueue: (id: string) => request<QueuedMessage[]>("GET", `/conversations/${seg(id)}/queue`),
  queueMessage: (id: string, body: SendMessageRequest) => request<QueuedMessage>("POST", `/conversations/${seg(id)}/queue`, body),
  removeQueued: (id: string, itemId: string) => request<Ok>("DELETE", `/conversations/${seg(id)}/queue/${seg(itemId)}`),
  sendQueuedNow: (id: string, itemId: string) => request<SendNowResult>("POST", `/conversations/${seg(id)}/queue/${seg(itemId)}/send`, {}),
  stopComputer: (id: string) =>
    request<ComputerSummary | null>("POST", `/conversations/${seg(id)}/computer/stop`, {}),

  /** Tasks: conversations that work in the background until they're done. */
  listTasks: (opts: { agentId?: string; status?: TaskStatus } = {}) => {
    const params = new URLSearchParams();
    if (opts.agentId) params.set("agentId", opts.agentId);
    if (opts.status) params.set("status", opts.status);
    const qs = params.toString();
    return request<Conversation[]>("GET", `/tasks${qs ? `?${qs}` : ""}`);
  },
  /** A fork of the chat, at a reply or whole: a new chat with the history so far. */
  forkChat: (conversationId: string, body: ForkRequest) => request<Conversation>("POST", `/conversations/${seg(conversationId)}/fork`, body),
  /** A fork's new messages go back to the chat it came from, for that chat's next reply; resolves with that chat. */
  mergeBack: (forkId: string) => request<Conversation>("POST", `/conversations/${seg(forkId)}/merge-back`, {}),
  /** A note for a running task; resolves with the saved message. */
  steerTask: (conversationId: string, text: string) => request<Message>("POST", `/conversations/${seg(conversationId)}/steer`, { text }),
  pauseTask: (id: string) => request<Conversation>("POST", `/tasks/${seg(id)}/pause`, {}),
  resumeTask: (id: string) => request<Conversation>("POST", `/tasks/${seg(id)}/resume`, {}),
  stopTask: (id: string) => request<Conversation>("POST", `/tasks/${seg(id)}/stop`, {}),
  runTaskNow: (id: string) => request<Conversation>("POST", `/tasks/${seg(id)}/run-now`, {}),
  /** A paused task queue (a provider kept failing) starts tasks again. */
  resumeQueue: (agentId: string) => request<Agent>("POST", `/agents/${seg(agentId)}/queue/resume`, {}),
  taskToChat: (id: string) => request<Ok>("POST", `/tasks/${seg(id)}/to-chat`, {}),
  patchTask: (id: string, patch: TaskPatch) => request<Conversation>("PATCH", `/tasks/${seg(id)}`, patch),
  taskChanges: (id: string) => request<TaskChanges>("GET", `/tasks/${seg(id)}/changes`),
  /** The task's own plan (its PLAN.md on the agent's computer); content null when there's none yet or the computer is off. */
  taskPlan: (id: string) => request<TaskPlan>("GET", `/tasks/${seg(id)}/plan`),
  /** Writes a handoff, then carries on in a fresh session on the other provider. */
  continueTaskOn: (id: string, provider: ContinueOnRequest["provider"]) =>
    request<Conversation>("POST", `/tasks/${seg(id)}/continue-on`, { provider }),

  // Module 09 · lane A (land): checks, merge, draft PR, update from base, discard.
  /** How a finished coding task can land right now: merge into the folder's branch, or a draft PR, each with why it can't. */
  taskLandOptions: (id: string) => request<TaskLandOptions>("GET", `/tasks/${seg(id)}/land`),
  /** Merges it into your folder (TOT does it there), or pushes its tot/* branch and opens a draft PR; 409 with the reason when it can't. */
  landTask: (id: string, body: LandTaskRequest) => request<Conversation>("POST", `/tasks/${seg(id)}/land`, body),
  /** Rebases its branch onto its base; on conflicts the task gets a turn to resolve them (it's "running" then). */
  updateTaskFromBase: (id: string) => request<Conversation>("POST", `/tasks/${seg(id)}/update-from-base`, {}),
  /** Stops it, removes its worktree, and deletes its branch unless it was pushed. */
  discardTask: (id: string) => request<Conversation>("POST", `/tasks/${seg(id)}/discard`, {}),
  /** Runs the repo's checks on its branch again; the result arrives as a task event. */
  runTaskChecks: (id: string) => request<Conversation>("POST", `/tasks/${seg(id)}/checks`, {}),

  // Module 09 · lane B (mission control, spawning, best-of).
  /** Mission control: open tasks, finished ones still to land (with their overlaps and land order), and the last day's landed ones. */
  getMission: (opts: { projectId?: string | null; agentId?: string; group?: string } = {}) => {
    const params = new URLSearchParams();
    if (opts.projectId) params.set("projectId", opts.projectId);
    if (opts.agentId) params.set("agentId", opts.agentId);
    if (opts.group) params.set("group", opts.group);
    const qs = params.toString();
    return request<MissionOverview>("GET", `/mission${qs ? `?${qs}` : ""}`);
  },
  /** A task started from a chat (the agent's own call, not a composer toggle): the request and its card are added to the chat. */
  startTaskFromChat: (conversationId: string, body: StartTaskRequest) =>
    request<Conversation>("POST", `/conversations/${seg(conversationId)}/tasks`, body),
  /** A top-level task, from a project's page (`projectId`) or an agent's home. */
  startTask: (body: StartTaskRequest & { agentId?: string; projectId?: string | null }) => request<Conversation>("POST", "/tasks", body),
  /** The same goal on Claude and ChatGPT (or twice on the one signed in), compared when they finish. */
  startBestOf: (body: BestOfRequest) => request<Conversation[]>("POST", "/tasks/best-of", body),

  // Module 09 · lane C (worktree lifecycle: previews, cleanup).
  /** Stops the task's preview (the dev server TOT runs for it); resolves with the task, its preview gone. */
  stopTaskPreview: (id: string) => request<Conversation>("POST", `/tasks/${seg(id)}/preview/stop`, {}),
  /** Removes worktrees of finished, unlanded tasks older than `days` (the saved setting when omitted); branches stay. */
  cleanUpWorktrees: (days?: number) => request<{ removed: number }>("POST", "/worktrees/cleanup", days === undefined ? {} : { days }),
  /** The setup command a project's lockfile implies: what its new worktrees run when it has none of its own. */
  detectProjectSetup: (id: string) => request<SetupDetection>("GET", `/projects/${seg(id)}/setup-detect`),

  // Module 11 · lane A (a project's repos).
  /** Adds a GitHub repo, or a folder on this Mac (`grant` once the user said yes), to a project; resolves with the project. */
  addProjectRepo: (projectId: string, body: AddProjectRepoRequest) => request<Project>("POST", `/projects/${seg(projectId)}/repos`, body),
  /** Renames a repo (its clone stays where it is), sets its base branch, or makes it the primary. */
  updateProjectRepo: (projectId: string, name: string, body: UpdateProjectRepoRequest) =>
    request<Project>("PATCH", `/projects/${seg(projectId)}/repos/${seg(name)}`, body),
  /** 409 while a task still has work in it; its files stay where they are. */
  removeProjectRepo: (projectId: string, name: string) => request<Project>("DELETE", `/projects/${seg(projectId)}/repos/${seg(name)}`),
  /** The user's OK for a folder repo (the consent dialog). */
  grantProjectRepo: (projectId: string, name: string) => request<Project>("POST", `/projects/${seg(projectId)}/repos/${seg(name)}/grant`, {}),

  // Module 11 · lane B (knowledge: status, panel).
  /** Where a project's knowledge lives (its repo), whether its wiki moved into git, and its page and fact counts. */
  knowledgeStatus: (projectId: string) => request<KnowledgeStatus>("GET", `/projects/${seg(projectId)}/knowledge`),
  /** The project's knowledge history, facts and pages alike, newest first. */
  knowledgeHistory: (projectId: string, opts: { limit?: number; skip?: number } = {}) =>
    request<KnowledgeCommit[]>("GET", `/projects/${seg(projectId)}/knowledge/history?limit=${opts.limit ?? 20}&skip=${opts.skip ?? 0}`),
  /** Undoes one change to the project's knowledge with a new commit; 409 when later changes touched the same lines. */
  undoKnowledge: (projectId: string, sha: string) => request<KnowledgeCommit>("POST", `/projects/${seg(projectId)}/knowledge/undo`, { sha }),

  // Module 11 · lane C (knowledge auto-updates).
  /** A project's knowledge auto-updates, newest first: runs in progress (`running`), then the last 50. */
  knowledgeUpdates: (projectId: string) => request<KnowledgeUpdate[]>("GET", `/projects/${seg(projectId)}/knowledge/updates`),
  /** Checks the project's repos for new commits now; an update is queued for each one that moved. */
  refreshKnowledge: (projectId: string) => request<KnowledgeRefreshResult>("POST", `/projects/${seg(projectId)}/knowledge/refresh`, {}),
  /** Puts back what one update changed, as a new commit; 409 when a page it wrote changed since. */
  undoKnowledgeUpdate: (projectId: string, updateId: string) =>
    request<KnowledgeUpdate>("POST", `/projects/${seg(projectId)}/knowledge/updates/${seg(updateId)}/undo`, {}),

  // Module 12 · lane A (signals, subscriptions).
  /** What the project's Lead heard about on its own (pull requests, tickets, schedules), newest first; unread ones have `readAt` null. */
  getProjectSignals: (projectId: string) => request<LeadSignal[]>("GET", `/projects/${seg(projectId)}/signals`),
  /** Looks at the project's pull requests now; its signals after. 409 with the reason (no GitHub connection, no Lead, watching off, rate limit). */
  checkProjectSignals: (projectId: string) => request<LeadSignal[]>("POST", `/projects/${seg(projectId)}/signals/check`, {}),
  /** Which pull requests the project's Lead hears about (default: the draft PRs TOT opened for its tasks). */
  getProjectSubscriptions: (projectId: string) => request<ProjectSubscriptions>("GET", `/projects/${seg(projectId)}/subscriptions`),
  updateProjectSubscriptions: (projectId: string, patch: UpdateProjectSubscriptionsRequest) =>
    request<ProjectSubscriptions>("PATCH", `/projects/${seg(projectId)}/subscriptions`, patch),

  // Module 12 · lane B (schedules).
  /** A project's schedules: they run in its Lead (a "schedule" signal), not as new chats. */
  listProjectSchedules: (projectId: string) => request<Routine[]>("GET", `/projects/${seg(projectId)}/schedules`),
  createProjectSchedule: (projectId: string, input: RoutineInput) => request<Routine>("POST", `/projects/${seg(projectId)}/schedules`, input),
  /** `{ enabled: false }` pauses it. */
  updateProjectSchedule: (projectId: string, routineId: string, patch: Partial<RoutineInput>) =>
    request<Routine>("PATCH", `/projects/${seg(projectId)}/schedules/${seg(routineId)}`, patch),
  deleteProjectSchedule: (projectId: string, routineId: string) => request<Ok>("DELETE", `/projects/${seg(projectId)}/schedules/${seg(routineId)}`),

  // Module 11 · lane D (the Lead, Home).
  /** The project's Lead chat: made the first time (with `agentId`, else the agent most active in the project), the same one after. */
  openLead: (projectId: string, agentId?: string | null) =>
    request<Conversation>("POST", `/projects/${seg(projectId)}/lead`, agentId ? { agentId } : {}),
  /** Every project's row on Home: needs you, working, ready to land, last activity, its Lead. */
  getHome: () => request<HomeProject[]>("GET", "/home"),
  /** Answers a Lead's land or discard card (it waits as long as it takes); `ok` false when it was approved but didn't land. */
  answerLeadAsk: (partId: string, decision: "accept" | "decline") =>
    request<{ status: "accepted" | "declined"; ok: boolean; text: string }>("POST", `/lead/asks/${seg(partId)}`, { decision }),

  stopRun: (runId: string) => request<Ok>("POST", `/runs/${seg(runId)}/stop`, {}),
  /** Answers a paused tool's approval request; 404s (as ApiError) once it's no longer pending. */
  answerApproval: (runId: string, partId: string, answer: ApprovalAnswer) =>
    request<Ok>("POST", `/runs/${seg(runId)}/approvals/${seg(partId)}`, answer),

  /** Projects (module 06): what the user works on — a GitHub repo, a folder on this Mac, or a topic — shared by every agent. */
  listProjects: ({ archived = false } = {}) => request<Project[]>("GET", archived ? "/projects?archived=1" : "/projects"),
  /** 409 when there's already a project for that source; 400 with the reason for bad input. `grant` allows a folder in the same call. */
  createProject: (body: CreateProjectRequest & { grant?: boolean }) => request<Project>("POST", "/projects", body),
  updateProject: (id: string, patch: UpdateProjectRequest) => request<Project>("PATCH", `/projects/${seg(id)}`, patch),
  /** Archives it: it leaves the sidebar; its chats and brain stay. */
  archiveProject: (id: string) => request<Project>("DELETE", `/projects/${seg(id)}`),
  /** Learn a repo into the project's brain; returns the study chat, filed under the project. */
  /** Learn the project's code; `repo` picks one of its repos (module 11), else the primary. */
  learnProject: (id: string, agentId: string, repo?: string) =>
    request<{ conversationId: string; runId: string }>("POST", `/projects/${seg(id)}/learn`, repo ? { agentId, repo } : { agentId }),
  /** A folder project: the user allows agents to work in the folder. */
  grantProjectFolder: (id: string) => request<Project>("POST", `/projects/${seg(id)}/grant`, {}),
  /** Git folders on this Mac, for the folder picker: `path` is absolute, `label` is "~/…". */
  recentProjectFolders: () => request<{ path: string; label: string }[]>("GET", "/projects/folders/recent"),
  /** macOS's folder picker, opened by the server on this Mac (a browser tab here): the folder, or null when cancelled. */
  pickProjectFolder: () => request<{ path: string | null }>("POST", "/projects/folders/pick", {}),

  /** Brains: knowledge bases at the app level — each agent's private notebook, and shared ones attached to agents. */
  listBrains: () => request<Brain[]>("GET", "/brains"),
  createBrain: (input: BrainInput) => request<Brain>("POST", "/brains", input),
  updateBrain: (id: string, patch: BrainPatch) => request<Brain>("PATCH", `/brains/${seg(id)}`, patch),
  deleteBrain: (id: string) => request<Ok>("DELETE", `/brains/${seg(id)}`),
  setBrainAccess: (id: string, agentId: string, access: BrainAccess) =>
    request<Brain>("PUT", `/brains/${seg(id)}/agents/${seg(agentId)}`, { access }),
  removeBrainAccess: (id: string, agentId: string) => request<Brain>("DELETE", `/brains/${seg(id)}/agents/${seg(agentId)}`),

  /** A brain's wiki: a page tree agents read/write with tools and the user can browse/edit. */
  listWikiPages: (brainId: string) => request<WikiPageSummary[]>("GET", `/brains/${seg(brainId)}/wiki`),
  searchWiki: (brainId: string, q: string) =>
    request<WikiSearchHit[]>("GET", `/brains/${seg(brainId)}/wiki?q=${encodeURIComponent(q)}`),
  createWikiPage: (brainId: string, input: WikiPageInput) =>
    request<WikiPage>("POST", `/brains/${seg(brainId)}/wiki`, input),
  /** Asks the agent to study a repo and write it up as its own brain; returns the chat to watch it happen. */
  learnRepo: (agentId: string, body: LearnRepoRequest) =>
    request<{ conversationId: string; runId: string; brainId: string }>("POST", `/agents/${seg(agentId)}/wiki/learn`, body),
  getWikiPage: (pageId: string) => request<WikiPage>("GET", `/wiki/${seg(pageId)}`),
  updateWikiPage: (pageId: string, patch: WikiPagePatch) =>
    request<WikiPage>("PATCH", `/wiki/${seg(pageId)}`, patch),
  deleteWikiPage: (pageId: string) => request<Ok>("DELETE", `/wiki/${seg(pageId)}`),
  listWikiRevisions: (pageId: string) => request<WikiRevision[]>("GET", `/wiki/${seg(pageId)}/revisions`),
  restoreWikiRevision: (pageId: string, revisionId: string) =>
    request<WikiPage>("POST", `/wiki/${seg(pageId)}/revisions/${seg(revisionId)}/restore`, {}),

  // Memory repo (module 10): memory is git repos of markdown, "you" and "projects/<slug>" (repo defaults to "you").
  listMemories: (opts: { q?: string; repo?: string } = {}) => {
    const params = new URLSearchParams();
    if (opts.q) params.set("q", opts.q);
    if (opts.repo) params.set("repo", opts.repo);
    const qs = params.toString();
    return request<Memory[]>("GET", `/memories${qs ? `?${qs}` : ""}`);
  },
  createMemory: (content: string, opts: { repo?: string; file?: string } = {}) => request<Memory>("POST", "/memories", { content, ...opts }),
  /** `expected`: the text the edit started from; a 409 when the entry says something else by now. */
  updateMemory: (id: string, content: string, repo?: string, expected?: string) =>
    request<Memory>("PATCH", `/memories/${seg(id)}${repo ? `?repo=${seg(repo)}` : ""}`, { content, ...(expected === undefined ? {} : { expected }) }),
  deleteMemory: (id: string, repo?: string) => request<Ok>("DELETE", `/memories/${seg(id)}${repo ? `?repo=${seg(repo)}` : ""}`),
  memoryRepos: () => request<MemoryRepoSummary[]>("GET", "/memory/repos"),
  memoryFiles: (repo: string) => request<MemoryFile[]>("GET", `/memory/${seg(repo)}/files`),
  memoryFile: (repo: string, path: string) => request<MemoryFileContent>("GET", `/memory/${seg(repo)}/file?path=${seg(path)}`),
  memoryHistory: (repo: string, opts: { limit?: number; skip?: number } = {}) =>
    request<MemoryCommit[]>("GET", `/memory/${seg(repo)}/history?limit=${opts.limit ?? 20}&skip=${opts.skip ?? 0}`),
  /** Undoes one change with a new commit; 409 when later changes touched the same lines. */
  revertMemory: (repo: string, sha: string) => request<MemoryCommit>("POST", `/memory/${seg(repo)}/revert`, { sha }),
  /** Starts Dreaming in the background; a `memory` event follows when it changed something. */
  dreamMemory: (repo?: string) => request<Ok>("POST", "/memory/dream", repo ? { repo } : {}),
  syncMemory: () => request<MemorySyncStatus>("POST", "/memory/sync", {}),
  /** An old memory the import left out as a secret: import it anyway, or drop it. */
  importSkippedMemory: (id: string) => request<Memory>("POST", `/memory/import/${seg(id)}`, {}),
  dropSkippedMemory: (id: string) => request<Ok>("DELETE", `/memory/import/${seg(id)}`),

  /** GitHub: one account connected for the whole app (issues/PRs/code search tools + git/gh login). */
  getGithubStatus: () => request<GitHubStatus>("GET", "/github"),
  connectGithub: (body: GitHubConnectRequest) => request<GitHubStatus>("POST", "/github/connect", body),
  /** Browser sign-in: show the returned code, then poll pollGithubDevice until it's no longer "pending". */
  startGithubDevice: () => request<GitHubDeviceStart>("POST", "/github/device", {}),
  pollGithubDevice: () => request<GitHubDevicePoll>("GET", "/github/device"),
  setGithubWrites: (allowWrites: boolean) => request<GitHubStatus>("PATCH", "/github", { allowWrites }),
  disconnectGithub: () => request<GitHubStatus>("DELETE", "/github"),
  listGithubRepos: (q?: string) =>
    request<GitHubRepo[]>("GET", q ? `/github/repos?q=${encodeURIComponent(q)}` : "/github/repos"),

  /** Apps (Executor): Gmail, Linear, Notion… connected once and shared by every agent. */
  getApps: () => request<AppsStatus>("GET", "/apps"),
  /** Whether this browser runs on the machine TOT runs on (only there can apps be added). */
  getAppsAccess: () => request<{ onThisMachine: boolean }>("GET", "/apps/access"),
  /** Installs Executor if needed, then starts it; follow the "apps" AppEvent for progress. */
  setupApps: () => request<AppsStatus>("POST", "/apps/setup", {}),
  stopApps: () => request<AppsStatus>("POST", "/apps/stop", {}),
  /** The catalog of apps TOT knows about (added ones first when `q` is empty). */
  appsCatalog: (q?: string) => request<AppCatalogItem[]>("GET", q ? `/apps/catalog?q=${encodeURIComponent(q)}` : "/apps/catalog"),
  /** Kicks off (or continues) connecting an app; follow the returned step. */
  connectApp: (body: AppConnectRequest) => request<AppConnectStep>("POST", "/apps/connect", body),
  pollAppConnect: (flowId: string) => request<AppConnectPoll>("GET", `/apps/connect/${seg(flowId)}`),
  /** Cancels a sign-in flow still waiting for the pop-up. */
  cancelAppConnect: (flowId: string) => request<Ok>("DELETE", `/apps/connect/${seg(flowId)}`),
  saveAppOAuthClient: (body: { appId: string; clientId: string; clientSecret: string }) =>
    request<Ok>("POST", "/apps/oauth-client", body),
  /** Removes the app, its accounts and its rules. */
  removeApp: (appId: string) => request<AppsStatus>("DELETE", `/apps/${seg(appId)}`),
  appRules: (appId: string) => request<AppRule[]>("GET", `/apps/${seg(appId)}/rules`),
  setAppRule: (appId: string, body: { tool: string; action: AppRule["action"] | "default" }) =>
    request<AppRule[]>("PUT", `/apps/${seg(appId)}/rules`, body),

  /** Slack: TOT's own bot, connected over Socket Mode. */
  /** Devices (module 07): this device, and the browsers and phones signed in to it. */
  getDevices: () => request<DevicesStatus>("GET", "/devices"),
  renameDevice: (name: string) => request<DevicesStatus>("PATCH", "/devices/self", { name }),
  signOutSession: (id: string) => request<DevicesStatus>("DELETE", `/sessions/${seg(id)}`),
  signOutOtherSessions: () => request<DevicesStatus>("POST", "/sessions/sign-out-others", {}),
  pairingLink: () => request<{ link: string; expiresAt: number }>("POST", "/devices/pairing-link", {}),
  connectDevice: (link: string) =>
    request<DevicesStatus & { deviceId: string; canReachYou: boolean }>("POST", "/devices/connect", { link } satisfies ConnectDeviceRequest),
  updateDevice: (id: string, patch: UpdateDeviceRequest) => request<DevicesStatus>("PATCH", `/devices/${seg(id)}`, patch),
  unpairDevice: (id: string) => request<DevicesStatus>("DELETE", `/devices/${seg(id)}`),
  /** Remote access (module 07): the switch, the password, and one-time sign-in links (QR codes) for phones. */
  setRemoteAccess: (mode: RemoteAccessMode) => request<DevicesStatus>("PATCH", "/access", { mode } satisfies UpdateRemoteAccessRequest),
  setSignInPassword: (body: SetPasswordRequest) => request<DevicesStatus>("POST", "/access/password", body),
  signInLink: (address?: string) => request<SignInLink>("POST", "/access/sign-in-link", { address } satisfies SignInLinkRequest),
  checkRemoteAccess: () => request<DevicesStatus>("POST", "/access/check", {}),

  getSlack: () => request<SlackStatus>("GET", "/slack"),
  setSlackTokens: (tokens: SlackTokens) => request<SlackStatus>("PUT", "/slack/tokens", tokens),
  patchSlack: (patch: SlackPatch) => request<SlackStatus>("PATCH", "/slack", patch),
  disconnectSlack: () => request<SlackStatus>("DELETE", "/slack"),

  /** Personas: identities (name, mailbox, optional GitHub account) agents can work as. */
  listPersonas: () => request<Persona[]>("GET", "/personas"),
  createPersona: (input: PersonaInput) => request<Persona>("POST", "/personas", input),
  updatePersona: (id: string, patch: PersonaPatch) => request<Persona>("PATCH", `/personas/${seg(id)}`, patch),
  deletePersona: (id: string) => request<Ok>("DELETE", `/personas/${seg(id)}`),
  /** Signs in over IMAP/SMTP; 400 with the reason when it doesn't work. */
  connectPersonaMailbox: (id: string, body: MailboxConnectRequest) =>
    request<Persona>("PUT", `/personas/${seg(id)}/mailbox`, body),
  disconnectPersonaMailbox: (id: string) => request<Persona>("DELETE", `/personas/${seg(id)}/mailbox`),
  refreshPersonaMailbox: (id: string) => request<Persona>("POST", `/personas/${seg(id)}/mailbox/refresh`, {}),
  listPersonaMail: (id: string, opts: { q?: string; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (opts.q) params.set("q", opts.q);
    if (opts.limit) params.set("limit", String(opts.limit));
    const qs = params.toString();
    return request<MailSummary[]>("GET", `/personas/${seg(id)}/mail${qs ? `?${qs}` : ""}`);
  },
  /** Fetches one message's full body; the server marks it read. */
  getPersonaMail: (id: string, mailId: string) => request<MailMessage>("GET", `/personas/${seg(id)}/mail/${seg(mailId)}`),
  /** Checks the token with GitHub; 400 with the reason when it doesn't work. */
  connectPersonaGithub: (id: string, body: PersonaGitHubConnectRequest) =>
    request<Persona>("PUT", `/personas/${seg(id)}/github`, body),
  setPersonaGithubWrites: (id: string, allowWrites: boolean) =>
    request<Persona>("PATCH", `/personas/${seg(id)}/github`, { allowWrites }),
  disconnectPersonaGithub: (id: string) => request<Persona>("DELETE", `/personas/${seg(id)}/github`),

  listPlugins: () => request<Plugin[]>("GET", "/plugins"),
  createPlugin: (input: PluginInput) => request<Plugin>("POST", "/plugins", input),
  updatePlugin: (id: string, input: Partial<PluginInput>) =>
    request<Plugin>("PATCH", `/plugins/${seg(id)}`, input),
  deletePlugin: (id: string) => request<Ok>("DELETE", `/plugins/${seg(id)}`),

  getSettings: () => request<Settings>("GET", "/settings"),
  updateSettings: (patch: SettingsPatch) => request<Settings>("PATCH", "/settings", patch),

  uploadFile: (file: File) => uploadFile(file),
};

/** Multipart upload; bypasses the JSON `request()` helper since the body isn't JSON. */
async function uploadFile(file: File): Promise<Attachment> {
  const device = deviceFor("/uploads");
  const form = new FormData();
  form.append("file", file);
  let response: Response;
  try {
    response = await fetch(apiUrl("/uploads", device), { method: "POST", body: form });
  } catch {
    throw new ApiError(UNREACHABLE, 0);
  }
  if (response.status === 401) redirectToSignIn();
  const data = parseBody(await response.text());
  if (!response.ok) throw new ApiError(serverError(data, response.status), response.status);
  return (device ? adopt(device, data) : data) as Attachment;
}
