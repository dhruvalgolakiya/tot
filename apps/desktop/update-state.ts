/**
 * Updates for the Mac app (roadmap module 08), the parts without Electron: what the web app's update prompt
 * is told, how electron-updater's events move it along, and what a check the user asked for answers. updates.ts
 * feeds the events in; the web app (apps/web/src/lib/desktop.ts) is built against `UpdateState`: keep the two in step.
 */

/** Sent to the web app on every change. Only `ready` and not `dismissed` shows the prompt. */
export type UpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "downloading"; version: string; percent: number }
  /** macOS has the update staged: a restart installs it, and so does quitting. */
  | { status: "ready"; version: string; dismissed: boolean };

export type UpdateEvent =
  | { type: "checking" }
  | { type: "available"; version: string }
  | { type: "progress"; percent: number }
  /** electron-updater has the zip; Squirrel.Mac is still unpacking and verifying it. */
  | { type: "downloaded"; version: string }
  /** Squirrel.Mac staged it. */
  | { type: "staged" }
  | { type: "not-available" }
  | { type: "error" }
  | { type: "dismiss" };

export const IDLE: UpdateState = { status: "idle" };

/**
 * A staged update stays ready until TOT restarts (the app stops checking once there is one); an error then can
 * only mean installing it failed. Before that, a failed check or download goes back to idle, quietly.
 */
export function nextUpdateState(state: UpdateState, event: UpdateEvent): UpdateState {
  if (state.status === "ready") {
    if (event.type === "dismiss") return { ...state, dismissed: true };
    return event.type === "error" ? IDLE : state;
  }
  switch (event.type) {
    case "checking":
      return state.status === "downloading" ? state : { status: "checking" };
    case "available":
      if (state.status === "downloading" && state.version === event.version) return state;
      return { status: "downloading", version: event.version, percent: 0 };
    case "progress":
      if (state.status !== "downloading") return state;
      return { ...state, percent: Math.min(100, Math.max(0, Math.round(event.percent))) };
    case "downloaded":
      return { status: "downloading", version: event.version, percent: 100 };
    case "staged":
      return state.status === "downloading" ? { status: "ready", version: state.version, dismissed: false } : state;
    case "not-available":
      return state.status === "checking" ? IDLE : state;
    case "error":
      return IDLE;
    case "dismiss":
      return state;
  }
}

/** What electron-updater rejects with: an Error, often with a `code` like ERR_UPDATER_NO_PUBLISHED_VERSIONS. */
export interface UpdateFailure {
  message: string;
  code?: string;
}

/** One line for the log: its messages can carry stack traces and whole XML feeds. */
export function failureLine(failure: UpdateFailure): string {
  const first = failure.message.split("\n").find((line) => line.trim())?.trim() ?? "unknown error";
  const line = failure.code && !first.includes(failure.code) ? `${failure.code}: ${first}` : first;
  return line.length > 300 ? `${line.slice(0, 299)}…` : line;
}

const NO_RELEASE = new Set(["ERR_UPDATER_NO_PUBLISHED_VERSIONS", "ERR_UPDATER_LATEST_VERSION_NOT_FOUND", "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND"]);
const OFFLINE = /net::ERR_|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH/;

/** Why a check the user asked for failed, in words they can act on. */
export function failureDetail(failure: UpdateFailure): string {
  if ((failure.code && NO_RELEASE.has(failure.code)) || /\b404\b/.test(failure.message)) return "There's no published TOT release to update from yet.";
  if (OFFLINE.test(failure.message)) return "TOT couldn't reach GitHub. Check your internet connection and try again.";
  if (/read-only volume/i.test(failure.message)) return "Move TOT to the Applications folder, open it from there and try again.";
  return "Something went wrong. The details are in TOT's log (Show log, in the menu bar icon's menu).";
}

/** How a check the user asked for came out. */
export type CheckOutcome =
  | { kind: "up-to-date"; current: string }
  | { kind: "available"; version: string }
  | { kind: "ready"; version: string }
  | { kind: "failed"; failure: UpdateFailure };

/** The dialog for Check for Updates…; `restart` offers Restart and Later. Background checks never show one. */
export interface CheckReply {
  message: string;
  detail: string;
  restart: boolean;
}

export function checkReply(outcome: CheckOutcome): CheckReply {
  switch (outcome.kind) {
    case "up-to-date":
      return { message: "You're up to date", detail: `TOT ${outcome.current} is the newest version.`, restart: false };
    case "available":
      return {
        message: `Downloading TOT ${outcome.version}`,
        detail: "TOT keeps working meanwhile. When it's ready, Restart to update appears in the sidebar; otherwise it installs the next time you quit TOT.",
        restart: false,
      };
    case "ready":
      return {
        message: `TOT ${outcome.version} is ready to install`,
        detail: "Restart TOT to finish updating. Chats and tasks still running stop when TOT restarts.",
        restart: true,
      };
    case "failed":
      return { message: "Couldn't check for updates", detail: failureDetail(outcome.failure), restart: false };
  }
}
