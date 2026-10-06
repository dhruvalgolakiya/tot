import type {
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
  ComputerSummary,
  Conversation,
  ContinueOnRequest,
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
  LandTaskRequest,
  LearnRepoRequest,
  MailMessage,
  MailSummary,
  Memory,
  MemoryCommit,
  MemoryFile,
  MemoryFileContent,
  MemoryRepoSummary,
  MemorySyncStatus,
  Message,
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
  ProviderId,
  ProviderStatus,
  SendMessageRequest,
  SendMessageResponse,
  Settings,
  SettingsPatch,
  SetupDetection,
  SlackPatch,
  SlackStatus,
  SlackTokens,
  StartTaskRequest,
  TaskChanges,
  TaskLandOptions,
  TaskPatch,
  TaskStatus,
  UpdateConversationRequest,
  UpdateDeviceRequest,
  UpdateRemoteAccessRequest,
  UpdateProjectRequest,
  UpdateProjectRepoRequest,
  WikiPage,
  WikiPageInput,
  WikiPagePatch,
  WikiPageSummary,
  WikiRevision,
  WikiSearchHit,
} from "@shared/types";
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

  listAgents: () => request<Agent[]>("GET", "/agents"),
  createAgent: (input: AgentInput) => request<Agent>("POST", "/agents", input),
  updateAgent: (id: string, input: Partial<AgentInput>) =>
    request<Agent>("PATCH", `/agents/${seg(id)}`, input),
  deleteAgent: (id: string) => request<Ok>("DELETE", `/agents/${seg(id)}`),
  stopAgentComputer: (id: string) =>
    request<ComputerSummary | null>("POST", `/agents/${seg(id)}/computer/stop`, {}),
  /** Opens (302s) to a fresh desktop-stream URL; call this to get a same-origin link to open in a new tab. */
  agentDesktopUrl: (id: string) => apiUrl(`/agents/${seg(id)}/computer/desktop`, deviceOf(id)),

  listConversations: (agentId?: string) =>
    request<Conversation[]>("GET", agentId ? `/conversations?agentId=${seg(agentId)}` : "/conversations"),
  createConversation: (body: CreateConversationRequest) =>
    request<Conversation>("POST", "/conversations", body),
  getConversation: (id: string) => request<ConversationDetail>("GET", `/conversations/${seg(id)}`),
  updateConversation: (id: string, body: UpdateConversationRequest) =>
    request<Conversation>("PATCH", `/conversations/${seg(id)}`, body),
  /** Tasks: `deleteBranch` also deletes the task's branch, if it was never pushed. */
  deleteConversation: (id: string, opts: { deleteBranch?: boolean } = {}) =>
    request<Ok>("DELETE", `/conversations/${seg(id)}${opts.deleteBranch ? "?deleteBranch=1" : ""}`),
  sendMessage: (id: string, body: SendMessageRequest) =>
    request<SendMessageResponse>("POST", `/conversations/${seg(id)}/messages`, body),
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
  /** A task started from a chat (the composer's Task mode): the request and its card are added to the chat. */
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

  // Module 11 · lane C (knowledge auto-updates).

  // Module 11 · lane D (the Lead, Home).

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
  learnProject: (id: string, agentId: string) =>
    request<{ conversationId: string; runId: string }>("POST", `/projects/${seg(id)}/learn`, { agentId }),
  /** A folder project: the user allows agents to work in the folder. */
  grantProjectFolder: (id: string) => request<Project>("POST", `/projects/${seg(id)}/grant`, {}),
  /** Git folders on this Mac, for the folder picker: `path` is absolute, `label` is "~/…". */
  recentProjectFolders: () => request<{ path: string; label: string }[]>("GET", "/projects/folders/recent"),

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
