import { create } from "zustand";
import { Folder, FolderGit, Layers, type LucideIcon } from "lucide-react";
import type { Conversation, CreateProjectRequest, Project, ProjectKind, UpdateProjectRequest } from "@tot/shared/types";
import { api } from "./api";
import { deviceOf, onDevice } from "./devices";
import { toMs } from "./format";

/**
 * Projects (roadmap module 06): what the user works on, shared by every agent. A GitHub repo, a
 * folder on this Mac, or a topic with no files; a chat is in one project or none. This store keeps
 * the list (live through the `project` AppEvent); the routing and chat moves are wired in store.ts.
 */

type LoadState = "loading" | "ready" | "error";

export interface ProjectsState {
  /** Every project, archived ones included (marked `archived`, so a chat filed in one can still name it); name order. */
  projects: Project[];
  state: LoadState;
  /** Project rows expanded in the sidebar (remembered on this device). */
  expanded: Set<string>;
  newProjectOpen: boolean;
}

const EXPANDED_KEY = "tot:projects-open";

function readExpanded(): Set<string> {
  try {
    const saved = JSON.parse(localStorage.getItem(EXPANDED_KEY) ?? "[]") as unknown;
    return new Set(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

export const useProjects = create<ProjectsState>()(() => ({
  projects: [],
  state: "loading",
  expanded: readExpanded(),
  newProjectOpen: false,
}));

const set = useProjects.setState;

function byName(a: Project, b: Project): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

/** Loaded at app init and on reconnect; kept live by `upsertProject` (the `project` AppEvent). Throws if the list fails. */
export async function loadProjects(): Promise<void> {
  const [active, archived] = await Promise.allSettled([api.listProjects(), api.listProjects({ archived: true })]);
  if (active.status === "rejected") {
    if (useProjects.getState().state !== "ready") set({ state: "error" });
    throw active.reason;
  }
  const list = [...active.value, ...(archived.status === "fulfilled" ? archived.value : [])];
  // Paired devices' projects (module 07) are loaded with their device.
  set((s) => ({ projects: [...list, ...s.projects.filter((p) => p.deviceId)].sort(byName), state: "ready" }));
}

/** A paired device's projects, tagged with it (module 07); replaces what was there from that device. */
export function mergeRemoteProjects(deviceId: string, projects: Project[]) {
  set((s) => ({ projects: [...s.projects.filter((p) => p.deviceId !== deviceId), ...projects].sort(byName) }));
}

export function removeDeviceProjects(deviceId: string) {
  set((s) => ({ projects: s.projects.filter((p) => p.deviceId !== deviceId) }));
}

/** A project the server just returned, or one from the `project` AppEvent (archived ones stay, marked). */
export function upsertProject(serverProject: Project) {
  // A paired device's project (module 07) stays tagged with its device.
  const deviceId = deviceOf(serverProject.id);
  const project = deviceId ? { ...serverProject, deviceId } : serverProject;
  set((s) => ({ projects: [project, ...s.projects.filter((p) => p.id !== project.id)].sort(byName) }));
}

export function setNewProjectOpen(open: boolean) {
  set({ newProjectOpen: open });
}

export function toggleProjectExpanded(id: string, open?: boolean) {
  set((s) => {
    const next = new Set(s.expanded);
    if (open ?? !next.has(id)) next.add(id);
    else next.delete(id);
    try {
      localStorage.setItem(EXPANDED_KEY, JSON.stringify([...next]));
    } catch {
      // Storage can be unavailable (private mode); the rows just won't stay open.
    }
    return { expanded: next };
  });
}

// ---------------------------------------------------------------------------
// Actions: they throw the server's message, for the dialogs to show inline.
// ---------------------------------------------------------------------------

/** Makes a project here, or on a paired device (`deviceId`, module 07). */
export async function createProject(body: CreateProjectRequest & { grant?: boolean }, deviceId: string | null = null): Promise<Project> {
  const project = await onDevice(deviceId, () => api.createProject(body));
  upsertProject(project);
  return project;
}

export async function updateProject(id: string, patch: UpdateProjectRequest): Promise<Project> {
  const project = await api.updateProject(id, patch);
  upsertProject(project);
  return project;
}

export async function archiveProject(id: string): Promise<Project> {
  const project = await api.archiveProject(id);
  upsertProject(project);
  return project;
}

export async function grantProjectFolder(id: string): Promise<Project> {
  const project = await api.grantProjectFolder(id);
  upsertProject(project);
  return project;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export const PROJECT_ICONS: Record<ProjectKind, LucideIcon> = {
  github: FolderGit,
  folder: Folder,
  none: Layers,
};

/** It has code to look at (and learn): a repo or a folder. */
export function isCodeProject(project: Pick<Project, "kind">): boolean {
  return project.kind !== "none";
}

/** The project a chat is in, if it's still listed (not archived). */
export function liveProject(projects: Project[], conversation: Pick<Conversation, "projectId">): Project | null {
  if (!conversation.projectId) return null;
  return projects.find((p) => p.id === conversation.projectId && !p.archived) ?? null;
}

const OWNER_REPO = /^[\w.-]+\/[\w.-]+$/;

export function isOwnerRepo(text: string): boolean {
  return OWNER_REPO.test(text.trim());
}

/** "/Users/dhruval/playground/x" → "~/playground/x" (display only; the server keeps the real path). */
export function tildePath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, "~");
}

/** "GitHub acme/web · main", "~/playground/meet-notes", or "No files". */
export function sourceLabel(project: Project): string {
  if (project.kind === "folder") return project.source ? tildePath(project.source) : "Folder";
  if (project.kind === "none") return "No files";
  const source = project.source ?? "";
  const repo = OWNER_REPO.test(source) ? `GitHub ${source}` : source.replace(/^[a-z]+:\/\//i, "").replace(/\.git$/i, "");
  return project.defaultBranch ? `${repo} · ${project.defaultBranch}` : repo;
}

/** The name a new project gets from what was picked: "acme/web" → "web", "~/code/meet-notes" → "meet-notes". */
export function nameFromSource(source: string): string {
  const clean = source
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  return clean.split(/[/:]/).pop() ?? "";
}

/** "ENG-123, eng-4" style comma (or space) lists → their items. */
export function parseList(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/** "now", "3m", "2h", "Mon", "Oct 1": compact times for list rows. */
export function shortTime(timestamp: number, now = Date.now()): string {
  const ms = toMs(timestamp);
  const minutes = Math.floor((now - ms) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const date = new Date(ms);
  if (hours < 24 * 6) return date.toLocaleDateString(undefined, { weekday: "short" });
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === new Date(now).getFullYear() ? undefined : "numeric",
  });
}
