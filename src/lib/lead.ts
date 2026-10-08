import { create } from "zustand";
import type { HomeProject } from "@shared/types";
import { api } from "./api";
import { onDevice } from "./devices";
import { useDevices } from "./remote";
import { showProjectDraft } from "../store";

/**
 * Workspaces (roadmap module 11, lane D): whether the project page shows its Lead or a new chat, and Home's
 * project rows from this device and the paired ones that are online.
 */

interface LeadUi {
  /** The project page starts a new chat in the project, instead of showing its Lead. */
  newChat: boolean;
}

export const useLeadUi = create<LeadUi>()(() => ({ newChat: false }));

/** A new chat in the project (Chats → New chat), or back to its Lead. */
export function setNewProjectChat(newChat: boolean) {
  useLeadUi.setState({ newChat });
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
