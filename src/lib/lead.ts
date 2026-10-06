import { create } from "zustand";
import type { HomeProject } from "@shared/types";
import { api } from "./api";
import { onDevice } from "./devices";
import { useDevices } from "./remote";
import { showProjectDraft } from "../store";

/**
 * Workspaces (roadmap module 11, lane D): the project page's side tabs (Board, Chats, Knowledge, Repos;
 * the last one picked is remembered on this device), which one shows on a phone (there the Lead is a tab
 * too, above the chat), and Home's project rows from this device and the paired ones that are online.
 */

export type ProjectTab = "board" | "chats" | "knowledge" | "repos";
/** On phones the Lead chat is a tab as well. */
export type PhoneTab = "lead" | ProjectTab;

export const PROJECT_TABS: { id: ProjectTab; label: string }[] = [
  { id: "board", label: "Board" },
  { id: "chats", label: "Chats" },
  { id: "knowledge", label: "Knowledge" },
  { id: "repos", label: "Repos" },
];

const TAB_KEY = "tot:project-tab";

function readTab(): ProjectTab {
  try {
    const saved = localStorage.getItem(TAB_KEY);
    return PROJECT_TABS.some((t) => t.id === saved) ? (saved as ProjectTab) : "board";
  } catch {
    return "board";
  }
}

interface LeadUi {
  tab: ProjectTab;
  phoneTab: PhoneTab;
  /** The middle of the project page starts a new chat in the project, instead of showing its Lead. */
  newChat: boolean;
}

export const useLeadUi = create<LeadUi>()(() => ({ tab: readTab(), phoneTab: "lead", newChat: false }));

export function setProjectTab(tab: ProjectTab) {
  useLeadUi.setState({ tab });
  try {
    localStorage.setItem(TAB_KEY, tab);
  } catch {
    // Storage can be unavailable (private mode); the tab just won't stick.
  }
}

export function setPhoneTab(tab: PhoneTab) {
  useLeadUi.setState({ phoneTab: tab });
}

/** A new chat in the project (Chats → New chat), or back to its Lead. */
export function setNewProjectChat(newChat: boolean) {
  useLeadUi.setState(newChat ? { newChat, phoneTab: "lead" } : { newChat });
  if (newChat) showProjectDraft();
}

/** Home's rows: this device's projects and the online paired devices' (tagged with their device), the most recently active first. */
export async function loadHome(): Promise<HomeProject[]> {
  const devices = useDevices.getState().status?.devices.filter((device) => device.online) ?? [];
  const [here, ...theirs] = await Promise.allSettled([
    api.getHome(),
    ...devices.map((device) =>
      onDevice(device.id, () => api.getHome()).then((rows) => rows.map((row) => ({ ...row, project: { ...row.project, deviceId: device.id } }))),
    ),
  ]);
  if (here.status === "rejected") throw here.reason;
  const rows = [...here.value, ...theirs.flatMap((result) => (result.status === "fulfilled" ? result.value : []))];
  return rows.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
}

/** "1 needs you · 2 working · 1 ready to land", or null when nothing's going on. */
export function homeCounts(row: Pick<HomeProject, "needsYou" | "working" | "readyToLand">): string | null {
  const parts = [
    row.needsYou ? `${row.needsYou} need${row.needsYou === 1 ? "s" : ""} you` : null,
    row.working ? `${row.working} working` : null,
    row.readyToLand ? `${row.readyToLand} ready to land` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}
