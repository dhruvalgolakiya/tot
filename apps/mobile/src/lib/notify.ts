import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Notifications from "expo-notifications";
import { AppState } from "react-native";
import { create } from "zustand";
import type { Conversation, TaskStatus } from "@shared/types";

/**
 * Local notifications (roadmap module 14, M4): an approval waiting, a task that needs input or finished or failed,
 * a reply that finished in a chat you're not looking at. No push: iOS keeps the app running only briefly after it
 * leaves the screen, so this notifies while the app is open or just backgrounded, and when it comes back it catches
 * up from /api/runs/live and the chats list (`catchUp`). What was already notified is remembered on the phone, per
 * TOT, so coming back never repeats a banner.
 *
 * Which tasks are worth a notification follows the web app's store (handleTaskEvent): done, failed and needs-input,
 * unless you're looking at that task. Like server/tasks/notify.ts, tasks whose results get combined into one answer
 * don't each notify: the combined reply does.
 */

export type NotifyKind = "approvals" | "tasks" | "replies";
export type NotifyPrefs = Record<NotifyKind, boolean>;

/** Where tapping a notification goes. */
export type NotifyTarget = { conversationId: string } | { screen: "tasks" };

const NOTIFY_STATUSES = new Set<TaskStatus>(["done", "failed", "needs-input"]);
/** More catch-up notifications than this at once become one summary, so coming back after a night isn't a wall of banners. */
const BURST = 3;
/** Keys remembered per TOT; old ones fall off (they're only for not notifying twice). */
const KEEP = 400;

const PREFS_KEY = "tot.notify.prefs";
const stateKey = (url: string) => `tot.notify.state:${url}`;

interface Remembered {
  /** When the app last knew everything (a catch-up); task changes after this are new. */
  seenAt: number;
  /** Notifications already shown (or deliberately skipped because you were looking). */
  keys: string[];
  /** Chats notified as waiting for you; one notification per wait, however many cards it shows. */
  waiting: string[];
  /** Chats with a reply running at the last look, so a reply that ended while away can be told. */
  running: string[];
}

export const useNotify = create<{ prefs: NotifyPrefs; permission: Notifications.NotificationPermissionsStatus | null }>()(() => ({
  prefs: { approvals: true, tasks: true, replies: true },
  permission: null,
}));

let tot: string | null = null;
let memory: Remembered | null = null;
let loading: Promise<void> | null = null;
/** The chat on screen (set by the chat screen while it's focused). */
let focused: string | null = null;

Notifications.setNotificationHandler({
  // Shown while the app is open too: catch-up banners arrive right as it comes back.
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
});

export async function loadNotifyPrefs() {
  const [saved, permission] = await Promise.all([AsyncStorage.getItem(PREFS_KEY).catch(() => null), Notifications.getPermissionsAsync().catch(() => null)]);
  const prefs = saved ? { ...useNotify.getState().prefs, ...(JSON.parse(saved) as Partial<NotifyPrefs>) } : useNotify.getState().prefs;
  useNotify.setState({ prefs, permission });
}

export async function setNotifyPref(kind: NotifyKind, on: boolean) {
  const prefs = { ...useNotify.getState().prefs, [kind]: on };
  useNotify.setState({ prefs });
  await AsyncStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
}

export async function refreshPermission() {
  useNotify.setState({ permission: await Notifications.getPermissionsAsync() });
}

/** Asks iOS once (the system prompt only ever shows once); later the Notifications screen points to iOS Settings. */
export async function askForNotifications(): Promise<void> {
  const current = await Notifications.getPermissionsAsync();
  const permission = current.status === "undetermined" ? await Notifications.requestPermissionsAsync({ ios: { allowAlert: true, allowSound: true, allowBadge: false } }) : current;
  useNotify.setState({ permission });
}

export function setFocusedChat(id: string | null) {
  focused = id;
}

const looking = (conversationId: string) => focused === conversationId && AppState.currentState === "active";

/** The TOT this phone is signed in to; its notified keys are its own (ids from two TOTs never meet). */
export function notifyFor(url: string | null) {
  if (url === tot) return;
  tot = url;
  memory = null;
  loading = url ? load(url) : null;
}

async function load(url: string) {
  try {
    const saved = await AsyncStorage.getItem(stateKey(url));
    memory = saved ? (JSON.parse(saved) as Remembered) : null;
  } catch {
    memory = null;
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function save() {
  if (!tot || !memory) return;
  const url = tot;
  const snapshot = memory;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void AsyncStorage.setItem(stateKey(url), JSON.stringify(snapshot)).catch(() => {}), 300);
}

/** Marks `key` as notified; false when it already was. */
function claim(key: string): boolean {
  if (!memory || memory.keys.includes(key)) return false;
  memory.keys.push(key);
  if (memory.keys.length > KEEP) memory.keys.splice(0, memory.keys.length - KEEP);
  return true;
}

const truncate = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1).trimEnd()}…` : text);

async function show(title: string, body: string, target: NotifyTarget) {
  if (!useNotify.getState().permission?.granted) return;
  await Notifications.scheduleNotificationAsync({ content: { title, body: truncate(body, 180), data: target }, trigger: null }).catch(() => {});
}

// ---------------------------------------------------------------------------
// What's worth a notification (the same words as the web's toasts)
// ---------------------------------------------------------------------------

type Note = { kind: NotifyKind; key: string; title: string; body: string; target: NotifyTarget };

function taskKey(task: Conversation): string | null {
  const info = task.task;
  if (!info || !NOTIFY_STATUSES.has(info.status)) return null;
  // A task can ask again on a later turn, and finish again after it's resumed: each is its own notification.
  return info.status === "needs-input" ? `task:${task.id}:needs-input:${info.turns}` : `task:${task.id}:${info.status}:${info.finishedAt ?? task.updatedAt}`;
}

function taskNote(task: Conversation): Note | null {
  const info = task.task;
  const key = taskKey(task);
  if (!info || !key) return null;
  // Its result goes into one combined answer, which notifies as a reply instead.
  if (info.status !== "needs-input" && info.then === "synthesize") return null;
  const title =
    info.status === "needs-input" ? `“${task.title}” needs your input` : `“${task.title}” ${info.status === "done" ? "is done" : "failed"}`;
  const body = info.status === "needs-input" ? (info.question ?? "It's waiting for your OK.") : (info.summary ?? "");
  return { kind: "tasks", key, title, body, target: { conversationId: task.id } };
}

/** A chat whose finished reply is worth telling: your own chats, not tasks, routines or Slack/email threads (those reply there). */
const repliesNotify = (chat: Conversation | undefined): chat is Conversation => Boolean(chat && chat.kind === "chat" && !chat.routineId && !chat.origin);

/** Shows notes that are new to this phone, skipping kinds turned off and the chat on screen; a burst becomes one summary. */
function post(notes: Note[]) {
  const prefs = useNotify.getState().prefs;
  const fresh = notes.filter((note) => claim(note.key) && prefs[note.kind] && !looking("conversationId" in note.target ? note.target.conversationId : ""));
  save();
  if (fresh.length > BURST) {
    void show(`${fresh.length} things happened in TOT`, summarize(fresh), { screen: "tasks" });
    return;
  }
  for (const note of fresh) void show(note.title, note.body, note.target);
}

// Live events come in bursts (six tasks started together finish together), and the event stream hands them over a
// few at a time: gather them until it's quiet for a second (three at most), so a burst is one summary.
let pending: Note[] = [];
let pendingTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSince = 0;

function deliver(note: Note | null) {
  if (!note) return;
  if (!pending.length) pendingSince = Date.now();
  pending.push(note);
  if (pendingTimer) clearTimeout(pendingTimer);
  pendingTimer = setTimeout(() => {
    const batch = pending;
    pending = [];
    pendingTimer = null;
    post(batch);
  }, Math.max(0, Math.min(1000, pendingSince + 3000 - Date.now())));
}

// ---------------------------------------------------------------------------
// Live: the store calls these from its event stream
// ---------------------------------------------------------------------------

export function onApproval(chat: Conversation | undefined, agentName: string, message: string, pending: boolean) {
  if (!memory || !chat) return;
  const waiting = memory.waiting.includes(chat.id);
  if (!pending) {
    if (waiting) {
      memory.waiting = memory.waiting.filter((id) => id !== chat.id);
      save();
    }
    return;
  }
  if (waiting) return;
  memory.waiting.push(chat.id);
  deliver({ kind: "approvals", key: `waiting:${chat.id}:${Date.now()}`, title: `${agentName} needs your OK`, body: message || chat.title || "A request is waiting in TOT.", target: { conversationId: chat.id } });
}

export function onTask(task: Conversation, previous: Conversation | undefined) {
  if (!memory || !task.task || previous?.task?.status === task.task.status) return;
  deliver(taskNote(task));
}

export function onRun(chat: Conversation | undefined, agentName: string, runId: string, status: string) {
  if (!memory || !chat) return;
  if (status === "running") {
    if (!memory.running.includes(chat.id)) memory.running.push(chat.id);
    save();
    return;
  }
  memory.running = memory.running.filter((id) => id !== chat.id);
  if (!repliesNotify(chat)) return save();
  const body = chat.title || "Open the chat to read it.";
  deliver({ kind: "replies", key: `reply:${runId}`, title: status === "error" ? `${agentName}'s reply failed` : `${agentName} replied`, body, target: { conversationId: chat.id } });
}

// ---------------------------------------------------------------------------
// Coming back: what changed while the app wasn't listening
// ---------------------------------------------------------------------------

export interface Snapshot {
  /** When the lists were requested (task changes up to then are covered). */
  at: number;
  conversations: Conversation[];
  /** Chats waiting for an approval right now, and chats with a reply running. */
  waiting: string[];
  running: string[];
  agentName: (agentId: string) => string;
}

/**
 * After every full load (launch, coming back, the event stream reconnecting): notify what changed since the last
 * look and isn't notified yet. The very first look at a TOT only remembers where things stand: no backlog.
 */
export async function catchUp(snapshot: Snapshot) {
  await loading;
  if (!tot) return;
  const byId = new Map(snapshot.conversations.map((c) => [c.id, c]));
  if (!memory) {
    memory = {
      seenAt: snapshot.at,
      keys: snapshot.conversations.flatMap((c) => taskKey(c) ?? []),
      waiting: [...snapshot.waiting],
      running: [...snapshot.running],
    };
    save();
    return;
  }
  const seenAt = memory.seenAt;
  const notes: Note[] = [];

  for (const id of snapshot.waiting) {
    if (memory.waiting.includes(id)) continue;
    memory.waiting.push(id);
    const chat = byId.get(id);
    if (chat) notes.push({ kind: "approvals", key: `waiting:${id}:${snapshot.at}`, title: `${snapshot.agentName(chat.agentId)} needs your OK`, body: chat.title || "A request is waiting in TOT.", target: { conversationId: id } });
  }
  memory.waiting = memory.waiting.filter((id) => snapshot.waiting.includes(id));

  for (const id of memory.running) {
    if (snapshot.running.includes(id)) continue;
    const chat = byId.get(id);
    if (repliesNotify(chat)) notes.push({ kind: "replies", key: `reply-ended:${id}:${chat.updatedAt}`, title: `${snapshot.agentName(chat.agentId)} replied`, body: chat.title || "Open the chat to read it.", target: { conversationId: id } });
  }
  memory.running = [...snapshot.running];

  for (const task of snapshot.conversations) {
    if (!task.task || task.updatedAt <= seenAt) continue;
    const note = taskNote(task);
    if (note) notes.push(note);
  }
  memory.seenAt = snapshot.at;

  post(notes);
}

function summarize(notes: Note[]): string {
  const count = (kind: NotifyKind) => notes.filter((n) => n.kind === kind).length;
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  return [
    count("approvals") ? `${plural(count("approvals"), "chat needs", "chats need")} your OK` : "",
    count("tasks") ? `${plural(count("tasks"), "task", "tasks")} finished or need you` : "",
    count("replies") ? plural(count("replies"), "reply", "replies") : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Where a tapped notification opens. */
export function targetOf(response: Notifications.NotificationResponse | null): NotifyTarget | null {
  const data = response?.notification.request.content.data as Partial<{ conversationId: string; screen: string }> | undefined;
  if (data?.conversationId) return { conversationId: data.conversationId };
  if (data?.screen === "tasks") return { screen: "tasks" };
  return null;
}
