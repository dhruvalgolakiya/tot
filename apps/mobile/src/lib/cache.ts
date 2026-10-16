import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Agent, Conversation, DevicesStatus, Message, ModelOption, Project, Settings } from "@shared/types";

/**
 * The last lists loaded from each TOT, kept on the phone (AsyncStorage, per address) so the app opens with them
 * when the TOT can't be reached (the Mac asleep, the phone off Tailscale) and shows them read-only under the
 * Reconnecting banner. It's a cache, not a copy: every load from the TOT replaces it, and nothing is ever sent from
 * it. A paired device that's offline keeps its agents and chats from here too, as the web keeps them per browser.
 */

export interface Snapshot {
  savedAt: number;
  devices: DevicesStatus | null;
  agents: Agent[];
  conversations: Conversation[];
  projects: Project[];
  settings: Settings | null;
  models: ModelOption[];
  deviceModels: Record<string, ModelOption[]>;
  /** The chats opened last (newest first), their latest messages only. */
  messages: Record<string, Message[]>;
  /** Which paired device each remembered id belongs to (lib/devices.ts), so cached rows still route there. */
  owners: [string, string][];
}

const VERSION = 1;
const key = (url: string) => `tot.cache.v${VERSION}:${url}`;
/** Chats whose messages are kept, and how many of each one's latest. */
export const CACHED_CHATS = 12;
export const CACHED_MESSAGES = 60;
/** Past this the messages are dropped from the cache (the lists alone are small). */
const MAX_BYTES = 2_000_000;

export async function readSnapshot(url: string): Promise<Snapshot | null> {
  try {
    const text = await AsyncStorage.getItem(key(url));
    return text ? (JSON.parse(text) as Snapshot) : null;
  } catch {
    return null;
  }
}

export async function writeSnapshot(url: string, snapshot: Snapshot): Promise<void> {
  let text = JSON.stringify(snapshot);
  if (text.length > MAX_BYTES) text = JSON.stringify({ ...snapshot, messages: {} });
  await AsyncStorage.setItem(key(url), text).catch(() => {});
}

/** A removed TOT's cache goes with it. */
export async function dropSnapshot(url: string): Promise<void> {
  await AsyncStorage.removeItem(key(url)).catch(() => {});
}
