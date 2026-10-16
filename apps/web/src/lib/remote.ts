import { create } from "zustand";
import type { Agent, Device, DevicesStatus } from "@shared/types";
import { api } from "./api";
import { adopt, forgetDevice, onDevice } from "./devices";
import { mergeRemoteProjects, removeDeviceProjects } from "./projects";
import { mergeRemote, removeDevice, setDeviceBrains, setDeviceModels } from "../store";

/**
 * Paired devices in this screen (roadmap module 07): their status, and their agents, chats and projects
 * merged into the app's lists, tagged with the device. Another device's agents are loaded when it comes
 * online; while it's offline they stay, faded, from the last time (remembered on this browser).
 */

interface DevicesState {
  status: DevicesStatus | null;
}

export const useDevices = create<DevicesState>()(() => ({ status: null }));

const set = useDevices.setState;
const CACHE_KEY = (id: string) => `tot:device-agents:${id}`;

/** Resolves once this screen knows every paired device's agents (or that it couldn't reach them). */
let settle!: () => void;
const settled = new Promise<void>((resolve) => (settle = resolve));
export const whenDevicesLoaded = () => settled;

export async function loadDevices(): Promise<void> {
  try {
    const status = await api.getDevices();
    set({ status });
    await Promise.all(status.devices.map((device) => (device.online ? loadRemote(device.id) : showCached(device.id))));
  } catch {
    // Devices are extra: the app works without them.
  } finally {
    settle();
  }
}

export function setDevicesStatus(status: DevicesStatus) {
  set({ status });
}

/** A paired device's agents, chats and projects, through this device. */
export async function loadRemote(deviceId: string): Promise<void> {
  try {
    const [agents, conversations, active, archived, models, brains] = await onDevice(deviceId, () =>
      Promise.all([
        api.listAgents(),
        api.listConversations(),
        api.listProjects(),
        api.listProjects({ archived: true }),
        api.listModels(),
        api.listBrains(),
      ]),
    );
    setDeviceModels(deviceId, models);
    setDeviceBrains(deviceId, brains);
    const tagged = agents.map((agent) => ({ ...agent, deviceId }));
    remember(deviceId, tagged);
    mergeRemote(deviceId, tagged, conversations);
    mergeRemoteProjects(deviceId, [...active, ...archived].map((project) => ({ ...project, deviceId })));
  } catch {
    showCached(deviceId);
  }
}

function remember(deviceId: string, agents: Agent[]) {
  try {
    localStorage.setItem(CACHE_KEY(deviceId), JSON.stringify(agents));
  } catch {
    // storage full or off
  }
}

/** An offline device's agents, as they were the last time this browser saw them. */
function showCached(deviceId: string) {
  let agents: Agent[] = [];
  try {
    agents = JSON.parse(localStorage.getItem(CACHE_KEY(deviceId)) ?? "[]") as Agent[];
  } catch {
    return;
  }
  if (!Array.isArray(agents) || !agents.length) return;
  mergeRemote(deviceId, adopt(deviceId, agents), null);
}

/** A `device` event: this device renamed, or a paired one paired, changed, online or offline. */
export function handleDeviceEvent(device: Device) {
  const status = useDevices.getState().status;
  if (!status) return;
  if (device.self) {
    set({ status: { ...status, self: device } });
    return;
  }
  const before = status.devices.find((d) => d.id === device.id);
  const devices = before ? status.devices.map((d) => (d.id === device.id ? device : d)) : [...status.devices, device];
  set({ status: { ...status, devices } });
  if (device.online && !before?.online) void loadRemote(device.id);
}

export function handleDeviceDeleted(deviceId: string) {
  const status = useDevices.getState().status;
  if (status) set({ status: { ...status, devices: status.devices.filter((d) => d.id !== deviceId) } });
  try {
    localStorage.removeItem(CACHE_KEY(deviceId));
  } catch {
    // storage off
  }
  removeDevice(deviceId);
  removeDeviceProjects(deviceId);
  forgetDevice(deviceId);
}

export const selectDevice = (deviceId: string | null | undefined) => (s: DevicesState) =>
  deviceId ? (s.status?.devices.find((d) => d.id === deviceId) ?? null) : null;

/** Paired devices exist: the UI only then mentions devices at all. */
export const selectHasPaired = (s: DevicesState) => Boolean(s.status?.devices.length);
