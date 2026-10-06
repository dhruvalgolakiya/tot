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
}

declare global {
  interface Window {
    totDesktop?: TotDesktopBridge;
  }
}

/** `null` outside the Mac app. Read once at load — the bridge doesn't appear or disappear later. */
export const totDesktop: TotDesktopBridge | null = window.totDesktop ?? null;
