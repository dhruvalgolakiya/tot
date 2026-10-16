import { app, autoUpdater as squirrel, dialog, type BrowserWindow } from "electron";
import { autoUpdater, type AppUpdater } from "electron-updater";
import { checkReply, IDLE, nextUpdateState, failureLine, type CheckOutcome, type UpdateEvent, type UpdateFailure, type UpdateState } from "./update-state.ts";

/**
 * Updates for the installed Mac app (roadmap module 08), from the GitHub releases of dhruvalgolakiya/tot
 * (app-update.yml, which electron-builder writes from builder.config.ts's `publish`). The first check is 10 s
 * after launch, then one every 4 hours; an update downloads in the background, Squirrel.Mac stages it, and it
 * installs when TOT quits, or at once through the web app's "Restart to update". Failures only go to the log;
 * a dialog appears only for Check for Updates…, which the user asked for.
 */

const FIRST_CHECK_MS = 10_000;
const CHECK_EVERY_MS = 4 * 60 * 60_000;

interface UpdatesOptions {
  log: (line: string) => void;
  /** Every change, for the web app. */
  onChange: (state: UpdateState) => void;
  /** Just before quitting to install: the window must close for real, not hide to the menu bar. */
  beforeInstall: () => void;
  /** Installing failed after beforeInstall(): TOT carries on. */
  installFailed: () => void;
}

function asFailure(error: unknown): UpdateFailure {
  if (!(error instanceof Error)) return { message: String(error) };
  const code = (error as { code?: unknown }).code;
  return { message: error.message, code: typeof code === "string" ? code : undefined };
}

export class Updates {
  private state: UpdateState = IDLE;
  private updater: AppUpdater | null = null;
  private installing = false;
  private asking = false;

  constructor(private readonly options: UpdatesOptions) {}

  get current(): UpdateState {
    return this.state;
  }

  /** Only the installed app updates: from a checkout there is nothing to replace. */
  get enabled(): boolean {
    return this.updater !== null;
  }

  start(): void {
    if (!app.isPackaged || this.updater) return;
    const updater = autoUpdater;
    updater.logger = null;
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;
    updater.on("checking-for-update", () => this.apply({ type: "checking" }));
    updater.on("update-available", (info) => {
      if (this.state.status !== "downloading" || this.state.version !== info.version) this.options.log(`Updates: TOT ${info.version} is out; downloading it.`);
      this.apply({ type: "available", version: info.version });
    });
    updater.on("download-progress", (progress) => this.apply({ type: "progress", percent: progress.percent }));
    updater.on("update-downloaded", (event) => this.apply({ type: "downloaded", version: event.version }));
    updater.on("update-not-available", (info) => {
      this.options.log(`Updates: up to date (the newest release is ${info.version}).`);
      this.apply({ type: "not-available" });
    });
    // Also Squirrel.Mac's own errors, which electron-updater passes on.
    updater.on("error", (error) => {
      this.options.log(`Updates: ${failureLine(asFailure(error))}`);
      this.apply({ type: "error" });
      if (this.installing) {
        this.installing = false;
        this.options.installFailed();
      }
    });
    squirrel.on("update-downloaded", () => {
      if (this.state.status === "downloading") this.options.log(`Updates: TOT ${this.state.version} is ready; it installs when TOT quits or restarts.`);
      this.apply({ type: "staged" });
    });
    this.updater = updater;
    setTimeout(() => void this.check(), FIRST_CHECK_MS);
    setInterval(() => void this.check(), CHECK_EVERY_MS);
  }

  /** A background check: none while an update downloads or waits for a restart. Errors are logged by the error event. */
  private async check(): Promise<void> {
    if (!this.updater || this.state.status === "downloading" || this.state.status === "ready") return;
    await this.updater.checkForUpdates().catch(() => {});
  }

  /** Check for Updates…, from the app menu or the menu bar icon: always answers, in a dialog. */
  async checkByUser(parent: BrowserWindow | null): Promise<void> {
    if (!this.updater || this.asking) return;
    this.asking = true;
    try {
      await this.answer(this.updater, parent);
    } finally {
      this.asking = false;
    }
  }

  private async answer(updater: AppUpdater, parent: BrowserWindow | null) {
    const reply = checkReply(await this.outcome(updater));
    const options: Electron.MessageBoxOptions = {
      type: "info",
      message: reply.message,
      detail: reply.detail,
      buttons: reply.restart ? ["Restart", "Later"] : ["OK"],
      defaultId: 0,
      cancelId: reply.restart ? 1 : 0,
    };
    const visible = parent && !parent.isDestroyed() && parent.isVisible() ? parent : null;
    // From the menu bar icon, with the window hidden: in front of the other apps, not behind them.
    if (!visible) app.focus({ steal: true });
    const { response } = visible ? await dialog.showMessageBox(visible, options) : await dialog.showMessageBox(options);
    if (reply.restart && response === 0) this.install();
  }

  private async outcome(updater: AppUpdater): Promise<CheckOutcome> {
    const state = this.state;
    if (state.status === "ready") return { kind: "ready", version: state.version };
    if (state.status === "downloading") return { kind: "available", version: state.version };
    try {
      const result = await updater.checkForUpdates();
      if (result?.isUpdateAvailable) return { kind: "available", version: result.updateInfo.version };
      return { kind: "up-to-date", current: app.getVersion() };
    } catch (error) {
      return { kind: "failed", failure: asFailure(error) };
    }
  }

  /** Quits TOT (stopping the server it started), installs the staged update and opens TOT again. */
  install(): void {
    if (!this.updater || this.state.status !== "ready" || this.installing) return;
    this.installing = true;
    this.options.log(`Updates: restarting to install TOT ${this.state.version}.`);
    this.options.beforeInstall();
    this.updater.quitAndInstall();
  }

  /** Hides the web app's prompt for this version until TOT next starts. */
  dismiss(): void {
    this.apply({ type: "dismiss" });
  }

  private apply(event: UpdateEvent) {
    const next = nextUpdateState(this.state, event);
    if (JSON.stringify(next) === JSON.stringify(this.state)) return;
    this.state = next;
    this.options.onChange(next);
  }
}
