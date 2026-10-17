import { create } from "zustand";
import type { Conversation } from "@tot/shared/types";
import type {
  WorkspaceCommit,
  WorkspaceDiff,
  WorkspaceFile,
  WorkspaceFileDiff,
  WorkspaceFiles,
  WorkspaceGit,
  WorkspaceGitResult,
  WorkspaceInfo,
  WorkspaceSaved,
  WorkspaceSearch,
  WorkspaceServer,
  WorkspaceTab,
  WorkspaceTerminal,
} from "@tot/shared/workspace";
import { request } from "./api";
import { apiUrl, deviceOf } from "./devices";

/**
 * The workspace panel beside a chat that works in a project folder or a worktree of its own: whether it's open
 * and how wide (per device, like the theme), and the tab each chat had open last.
 */

const PANEL_KEY = "tot:workspace-panel";
const TABS_KEY = "tot:workspace-tabs";
/** Chats whose last tab is remembered; the oldest are forgotten first. */
const REMEMBERED_TABS = 200;

export const PANEL_MIN_WIDTH = 360;
export const PANEL_DEFAULT_WIDTH = 560;

/** Something asked of the Files tab from elsewhere: quick open (⌘P), search (⌘⇧F), or a file to show at a line. */
export type FilesIntent = { kind: "quick-open" } | { kind: "search" } | { kind: "open"; path: string; line?: number };

interface WorkspacePanelState {
  open: boolean;
  width: number;
  tabs: Record<string, WorkspaceTab>;
  filesIntent: (FilesIntent & { chatId: string; nonce: number }) | null;
}

function read<T>(key: string, fallback: T): T {
  try {
    const saved = localStorage.getItem(key);
    return saved ? { ...fallback, ...(JSON.parse(saved) as T) } : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode or a full disk: it's only a preference.
  }
}

const saved = read<{ open: boolean; width: number }>(PANEL_KEY, { open: false, width: PANEL_DEFAULT_WIDTH });

export const useWorkspacePanel = create<WorkspacePanelState>()(() => ({
  open: saved.open,
  width: Math.max(PANEL_MIN_WIDTH, Number(saved.width) || PANEL_DEFAULT_WIDTH),
  tabs: read<Record<string, WorkspaceTab>>(TABS_KEY, {}),
  filesIntent: null,
}));

const set = useWorkspacePanel.setState;
const savePanel = () => {
  const { open, width } = useWorkspacePanel.getState();
  write(PANEL_KEY, { open, width });
};

export function setWorkspacePanelOpen(open: boolean): void {
  set({ open });
  savePanel();
}

export const toggleWorkspacePanel = () => setWorkspacePanelOpen(!useWorkspacePanel.getState().open);

/** While dragging; `save` once it's let go. */
export function setWorkspacePanelWidth(width: number, { save = false } = {}): void {
  set({ width: Math.round(Math.max(PANEL_MIN_WIDTH, width)) });
  if (save) savePanel();
}

export function setWorkspaceTab(chatId: string, tab: WorkspaceTab): void {
  const { [chatId]: _previous, ...others } = useWorkspacePanel.getState().tabs;
  const kept = Object.entries(others).slice(-(REMEMBERED_TABS - 1));
  const tabs = { ...Object.fromEntries(kept), [chatId]: tab };
  set({ tabs });
  write(TABS_KEY, tabs);
}

let nonce = 0;

/** Opens the chat's Files tab for something: quick open, search, or a file (at a line). */
export function askFiles(chatId: string, intent: FilesIntent): void {
  setWorkspaceTab(chatId, "files");
  set({ open: true, filesIntent: { ...intent, chatId, nonce: ++nonce } });
  savePanel();
}

/** A chat with a folder the panel can show: one that picked where it works (its worktree made on its first message). */
export function hasWorkspace(chat: Conversation | undefined): chat is Conversation & { workspace: NonNullable<Conversation["workspace"]> } {
  if (!chat || chat.kind === "task" || !chat.workspace) return false;
  return chat.workspace.mode === "checkout" || chat.workspace.created;
}

const seg = encodeURIComponent;
const base = (chatId: string) => `/conversations/${seg(chatId)}/workspace`;

export const workspaceApi = {
  info: (chatId: string) => request<WorkspaceInfo>("GET", base(chatId)),
  diff: (chatId: string) => request<WorkspaceDiff>("GET", `${base(chatId)}/diff`),
  diffFile: (chatId: string, path: string, oldPath?: string) =>
    request<WorkspaceFileDiff>("GET", `${base(chatId)}/diff/file?path=${seg(path)}${oldPath ? `&old=${seg(oldPath)}` : ""}`),
  files: (chatId: string) => request<WorkspaceFiles>("GET", `${base(chatId)}/files`),
  file: (chatId: string, path: string) => request<WorkspaceFile>("GET", `${base(chatId)}/file?path=${seg(path)}`),
  rawUrl: (chatId: string, path: string, mtime: number) => apiUrl(`${base(chatId)}/raw?path=${seg(path)}&v=${Math.round(mtime)}`, deviceOf(chatId)),
  save: (chatId: string, path: string, content: string, baseMtime?: number) =>
    request<WorkspaceSaved>("PUT", `${base(chatId)}/file`, { path, content, baseMtime }),
  search: (chatId: string, query: string, { regex = false, caseSensitive = false } = {}) =>
    request<WorkspaceSearch>("GET", `${base(chatId)}/search?q=${seg(query)}${regex ? "&regex=1" : ""}${caseSensitive ? "&case=1" : ""}`),
  git: (chatId: string) => request<WorkspaceGit>("GET", `${base(chatId)}/git`),
  suggestCommitMessage: (chatId: string) => request<{ message: string }>("POST", `${base(chatId)}/git/message`, {}),
  commit: (chatId: string, body: WorkspaceCommit) => request<WorkspaceGitResult>("POST", `${base(chatId)}/git/commit`, body),
  push: (chatId: string, confirmDefault = false) => request<WorkspaceGitResult>("POST", `${base(chatId)}/git/push`, { confirmDefault }),
  pull: (chatId: string) => request<WorkspaceGitResult>("POST", `${base(chatId)}/git/pull`, {}),
  sync: (chatId: string, confirmDefault = false) => request<WorkspaceGitResult>("POST", `${base(chatId)}/git/sync`, { confirmDefault }),
  servers: (chatId: string) => request<WorkspaceServer[]>("GET", `${base(chatId)}/servers`),
  terminals: (chatId: string) => request<WorkspaceTerminal[]>("GET", `${base(chatId)}/terminals`),
  openTerminal: (chatId: string, size: { cols?: number; rows?: number } = {}) => request<WorkspaceTerminal>("POST", `${base(chatId)}/terminals`, size),
  closeTerminal: (id: string) => request<{ ok: true }>("DELETE", `/workspace/terminals/${seg(id)}`),
  /** The stream that says when files in the chat's folder changed (on the device that has the chat). */
  eventsUrl: (chatId: string) => apiUrl(`${base(chatId)}/events`, deviceOf(chatId)),
};
