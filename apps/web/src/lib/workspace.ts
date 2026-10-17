import { create } from "zustand";
import type { Conversation } from "@tot/shared/types";
import type { WorkspaceInfo, WorkspaceTab } from "@tot/shared/workspace";
import { request } from "./api";

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

interface WorkspacePanelState {
  open: boolean;
  width: number;
  tabs: Record<string, WorkspaceTab>;
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

/** A chat with a folder the panel can show: one that picked where it works (its worktree made on its first message). */
export function hasWorkspace(chat: Conversation | undefined): chat is Conversation & { workspace: NonNullable<Conversation["workspace"]> } {
  if (!chat || chat.kind === "task" || !chat.workspace) return false;
  return chat.workspace.mode === "checkout" || chat.workspace.created;
}

const seg = encodeURIComponent;
const base = (chatId: string) => `/conversations/${seg(chatId)}/workspace`;

export const workspaceApi = {
  info: (chatId: string) => request<WorkspaceInfo>("GET", base(chatId)),
};
