import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { UpdateState } from "./update-state.ts";

/**
 * What TOT's web app can ask of the Mac app (roadmap module 08), as `window.totDesktop`. This is the whole
 * contract, and the web app (src/lib/desktop.ts) is built against it: keep the two in step. The page runs
 * sandboxed and isolated; the main process answers only TOT's own origin.
 */

export interface TotDesktop {
  platform: "darwin";
  version: string;
  getOpenAtLogin(): Promise<boolean>;
  /** Resolves to the new state (unchanged when it can't be set, e.g. running from a checkout). */
  setOpenAtLogin(open: boolean): Promise<boolean>;
  /** The macOS folder picker, as a sheet on TOT's window: the folder chosen, or null when cancelled. */
  pickFolder(): Promise<string | null>;
  /** The app's own updates (updates.ts), for the "Update ready" prompt. */
  updates: TotUpdates;
}

export interface TotUpdates {
  /** Calls `listener` with the current state, then on every change. Returns a function that stops it. */
  onState(listener: (state: UpdateState) => void): () => void;
  /** Quits TOT, installs the downloaded update and opens TOT again. */
  install(): Promise<void>;
  /** Hides the prompt for this version until TOT next starts. */
  dismiss(): Promise<void>;
}

const updates: TotUpdates = {
  onState(listener) {
    let stopped = false;
    const relay = (_event: IpcRendererEvent, state: UpdateState) => listener(state);
    ipcRenderer.on("tot:update-state", relay);
    ipcRenderer.invoke("tot:get-update-state").then(
      (state: UpdateState) => {
        if (!stopped) listener(state);
      },
      () => {},
    );
    return () => {
      stopped = true;
      ipcRenderer.removeListener("tot:update-state", relay);
    };
  },
  install: () => ipcRenderer.invoke("tot:install-update"),
  dismiss: () => ipcRenderer.invoke("tot:dismiss-update"),
};

const VERSION_ARG = "--tot-version=";

const desktop: TotDesktop = {
  platform: "darwin",
  version: process.argv.find((arg) => arg.startsWith(VERSION_ARG))?.slice(VERSION_ARG.length) ?? "",
  getOpenAtLogin: () => ipcRenderer.invoke("tot:get-open-at-login"),
  setOpenAtLogin: (open) => ipcRenderer.invoke("tot:set-open-at-login", open),
  pickFolder: () => ipcRenderer.invoke("tot:pick-folder"),
  updates,
};

contextBridge.exposeInMainWorld("totDesktop", desktop);
