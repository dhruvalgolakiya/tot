import { contextBridge, ipcRenderer } from "electron";

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
}

const VERSION_ARG = "--tot-version=";

const desktop: TotDesktop = {
  platform: "darwin",
  version: process.argv.find((arg) => arg.startsWith(VERSION_ARG))?.slice(VERSION_ARG.length) ?? "",
  getOpenAtLogin: () => ipcRenderer.invoke("tot:get-open-at-login"),
  setOpenAtLogin: (open) => ipcRenderer.invoke("tot:set-open-at-login", open),
  pickFolder: () => ipcRenderer.invoke("tot:pick-folder"),
};

contextBridge.exposeInMainWorld("totDesktop", desktop);
