/**
 * The Mac app's bridge (electron/ exposes this from its preload script when TOT runs inside the
 * Electron shell, with `titleBarStyle: "hiddenInset"`). `undefined` in a normal browser tab or on
 * a phone, so every call site guards on `totDesktop` first.
 */
export interface TotDesktopBridge {
  platform: "darwin";
  version: string;
  getOpenAtLogin(): Promise<boolean>;
  /** Resolves to the new state. */
  setOpenAtLogin(open: boolean): Promise<boolean>;
  /** The macOS folder picker as a sheet on TOT's window: the folder chosen, or null when cancelled. Missing in Mac apps before it. */
  pickFolder?(): Promise<string | null>;
  /** The app's own updates. Missing in Mac apps before them (0.1.1 and older). */
  updates?: TotDesktopUpdates;
}

/** As electron/update-state.ts's UpdateState. The prompt shows only a `ready` update that isn't `dismissed`. */
export type AppUpdateState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "downloading"; version: string; percent: number }
  | { status: "ready"; version: string; dismissed: boolean };

export interface TotDesktopUpdates {
  /** Calls `listener` with the current state, then on every change. Returns a function that stops it. */
  onState(listener: (state: AppUpdateState) => void): () => void;
  /** Quits TOT, installs the downloaded update and opens TOT again. */
  install(): Promise<void>;
  /** Hides the prompt for this version until TOT next starts. */
  dismiss(): Promise<void>;
}

declare global {
  interface Window {
    totDesktop?: TotDesktopBridge;
  }
}

/** `null` outside the Mac app. Read once at load — the bridge doesn't appear or disappear later. */
export const totDesktop: TotDesktopBridge | null = window.totDesktop ?? null;
