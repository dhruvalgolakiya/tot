import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  Notification,
  screen,
  session,
  shell,
  Tray,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from "electron";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  ACTION_SCHEME,
  didntStartPage,
  notBuiltPage,
  pageUrl,
  portTakenPage,
  startingPage,
  stoppedPage,
  unreachablePage,
  type PageAction,
} from "./pages.ts";
import { accessLabel, accessMode, planLaunch, probeTot } from "./probe.ts";
import { logLine, ServerProcess, trimLog, type ServerExit } from "./server-process.ts";
import { mergePath, readLoginShellPath, writeShims } from "./shell-env.ts";
import { isAppUrl, isExternalUrl, MIN_SIZE, placeWindow, type SavedWindow } from "./window-rules.ts";

/**
 * TOT for macOS (roadmap module 08): a window onto the TOT server, which the app starts with its own Node and
 * stops on Quit, or simply opens when a TOT already runs on the port. Closing the window keeps TOT running in
 * the menu bar, so phones and paired devices keep working.
 */

app.setName("TOT");
app.setPath("userData", join(app.getPath("appData"), "TOT"));

const PORT = Number(process.env.TOT_PORT ?? 8787);
/** A loopback name: this computer never signs in. */
const ORIGIN = `http://localhost:${PORT}`;
/** Holds dist/ (the built web app, served from the server's cwd) and node_modules/. */
const APP_DIR = app.getAppPath();
const LOG_FILE = join(homedir(), "Library", "Logs", "TOT", "server.log");
const STATE_FILE = join(app.getPath("userData"), "state.json");
const SHIM_DIR = join(app.getPath("userData"), "bin");
const DEVTOOLS = !app.isPackaged || process.env.TOT_DEVTOOLS === "1";
/** After stopping unexpectedly, the server restarts by itself once; again only after this long. */
const AUTO_RESTART_EVERY_MS = 5 * 60_000;
/**
 * Web permissions TOT's pages get: task notifications, Copy buttons, full-screen. Nothing else, nowhere else.
 * No microphone: dictation needs Chrome's speech service, which Electron lacks, so the app hides it.
 */
const PERMISSIONS = new Set(["notifications", "clipboard-sanitized-write", "fullscreen"]);

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let launching: Promise<void> | null = null;
let lastAutoRestart = 0;

const server = new ServerProcess(
  { execPath: process.execPath, entry: join(__dirname, "server.mjs"), cwd: APP_DIR, port: PORT, logFile: LOG_FILE },
  (exit) => void serverStopped(exit),
);

// ---------------------------------------------------------------------------
// What the app remembers: the window's place, and whether it explained closing
// ---------------------------------------------------------------------------

interface State {
  window?: SavedWindow;
  closeHintShown?: boolean;
}

function readState(): State {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as State;
  } catch {
    return {};
  }
}

function saveState(patch: State) {
  try {
    writeFileSync(STATE_FILE, JSON.stringify({ ...readState(), ...patch }, null, 2));
  } catch {
    // Not worth failing over.
  }
}

function saveWindow() {
  if (win && !win.isDestroyed()) saveState({ window: { ...win.getNormalBounds(), maximized: win.isMaximized() } });
}

// ---------------------------------------------------------------------------
// Starting TOT, or opening the one already running
// ---------------------------------------------------------------------------

/** PATH from the login shell, Homebrew, then the shims: worked out once per launch, while the window opens. */
async function prepareEnvironment() {
  try {
    writeShims(SHIM_DIR, process.execPath, join(APP_DIR, "node_modules", "npm", "bin"));
  } catch (err) {
    logLine(LOG_FILE, `Couldn't write the node/npm shims: ${err instanceof Error ? err.message : err}`);
  }
  process.env.PATH = mergePath({ shellPath: await readLoginShellPath(), currentPath: process.env.PATH, shimDir: SHIM_DIR });
}
let environment: Promise<void> = Promise.resolve();

/** Opens the TOT on the port, or starts one, or says what's wrong. Calling it again while it runs waits for that run. */
function launch(): Promise<void> {
  launching ??= openTot().finally(() => (launching = null));
  return launching;
}

async function openTot() {
  showPage(startingPage());
  const [probe] = await Promise.all([probeTot(PORT), environment]);
  const plan = planLaunch(probe);
  if (plan === "attach") {
    logLine(LOG_FILE, `TOT is already running on port ${PORT}${probe.kind === "tot" ? ` (${probe.name})` : ""}: opening it.`);
    return loadApp();
  }
  if (plan === "blocked") {
    logLine(LOG_FILE, `Port ${PORT} is taken by another program. ${probe.kind === "other" ? probe.detail : ""}`);
    return showPage(portTakenPage(PORT));
  }
  if (!existsSync(join(APP_DIR, "dist", "index.html"))) return showPage(notBuiltPage());
  if (quitting) return;
  logLine(LOG_FILE, `Starting the TOT server on port ${PORT}.`);
  server.start();
  const result = await server.waitReady();
  if (result === "ready") return loadApp();
  if (result === "timeout") {
    logLine(LOG_FILE, "The TOT server didn't answer within a minute; stopping it.");
    await server.stop();
    showPage(didntStartPage());
  }
  // "exited": serverStopped() takes it from here.
}

async function serverStopped(exit: ServerExit) {
  if (quitting) return;
  logLine(LOG_FILE, `The TOT server stopped unexpectedly (${exit.signal ?? `exit code ${exit.code}`}).`);
  await launching;
  if (Date.now() - lastAutoRestart > AUTO_RESTART_EVERY_MS) {
    lastAutoRestart = Date.now();
    logLine(LOG_FILE, "Restarting it.");
    return launch();
  }
  showPage(stoppedPage(exit));
}

// A load that fails or is cut short by the next one rejects; did-fail-load shows what to do about it.
function loadApp() {
  if (win && !win.isDestroyed()) win.loadURL(`${ORIGIN}/`).catch(() => {});
}

function showPage(html: string) {
  if (win && !win.isDestroyed()) win.loadURL(pageUrl(html)).catch(() => {});
}

function act(action: PageAction) {
  if (action === "start") void launch();
  else void shell.openPath(LOG_FILE);
}

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

const background = () => (nativeTheme.shouldUseDarkColors ? "#212121" : "#ffffff");

/** `showWhenReady` false: TOT was started at login, and stays in the menu bar until asked. */
function createWindow(showWhenReady: boolean): BrowserWindow {
  const saved = readState().window ?? null;
  const bounds = placeWindow(
    saved,
    screen.getAllDisplays().map((display) => display.workArea),
    screen.getPrimaryDisplay().workArea,
  );
  const window = new BrowserWindow({
    ...bounds,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    show: false,
    title: "TOT",
    titleBarStyle: "hiddenInset",
    // Centred in the web app's 80 px rail, level with its 56 px top bars.
    trafficLightPosition: { x: 14, y: 21 },
    // The page's own canvas colour: no white flash in dark mode.
    backgroundColor: background(),
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      devTools: DEVTOOLS,
      additionalArguments: [`--tot-version=${app.getVersion()}`],
    },
  });

  window.once("ready-to-show", () => {
    if (!showWhenReady) app.dock?.hide();
    else if (saved?.maximized) window.maximize();
    else window.show();
  });

  let saveTimer: NodeJS.Timeout | undefined;
  const saveSoon = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveWindow, 500);
  };
  window.on("resize", saveSoon);
  window.on("move", saveSoon);
  window.on("close", (event) => {
    saveWindow();
    if (quitting) return;
    event.preventDefault();
    hideToMenuBar();
  });
  // The page itself can close the window (window.close() skips "close"): TOT stays in the menu bar, and
  // showWindow() makes a new one.
  window.on("closed", () => {
    if (win === window) win = null;
    if (!quitting) app.dock?.hide();
  });

  const contents = window.webContents;
  // TOT's own pages stay in the window; every other link opens in the default browser.
  contents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: "deny" };
  });
  contents.on("will-navigate", (event, url) => {
    if (url.startsWith(ACTION_SCHEME)) {
      event.preventDefault();
      const action = url.slice(ACTION_SCHEME.length);
      if (action === "start" || action === "log") act(action);
      return;
    }
    if (isAppUrl(url, PORT)) return;
    event.preventDefault();
    openOutside(url);
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
  // A TOT we only attached to went away (its terminal closed): offer to start one.
  contents.on("did-fail-load", (_event, code, _description, url, isMainFrame) => {
    if (isMainFrame && code !== -3 && !quitting && isAppUrl(url, PORT)) showPage(unreachablePage(PORT));
  });
  contents.on("render-process-gone", (_event, details) => {
    if (details.reason !== "clean-exit" && !quitting) contents.reload();
  });
  return window;
}

function openOutside(url: string) {
  if (isExternalUrl(url)) void shell.openExternal(url);
}

async function showWindow() {
  if (quitting) return;
  const existing = win;
  // A new window shows itself once its first page is drawn.
  if (!existing) {
    win = createWindow(true);
    if (server.running) loadApp();
    else void launch();
  }
  await app.dock?.show();
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
  }
  app.focus({ steal: true });
}

/** Closing the window: TOT keeps running in the menu bar, without a Dock icon. */
function hideToMenuBar() {
  if (!win) return;
  // A hidden full-screen window leaves an empty Space behind.
  if (win.isFullScreen()) {
    win.once("leave-full-screen", hideToMenuBar);
    win.setFullScreen(false);
    return;
  }
  win.hide();
  app.dock?.hide();
  if (!readState().closeHintShown && Notification.isSupported()) {
    new Notification({
      title: "TOT is still running in the menu bar.",
      body: "Your phone and paired devices keep working. Quit from the menu bar icon.",
      silent: true,
    }).show();
    saveState({ closeHintShown: true });
  }
}

function appMenu(): Menu {
  const view: MenuItemConstructorOptions[] = [
    { role: "reload" },
    { role: "forceReload" },
    ...(DEVTOOLS ? [{ role: "toggleDevTools" } as const] : []),
    { type: "separator" },
    { role: "resetZoom" },
    { role: "zoomIn" },
    { role: "zoomOut" },
    { type: "separator" },
    { role: "togglefullscreen" },
  ];
  return Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { label: "View", submenu: view }, { role: "windowMenu" }]);
}

// ---------------------------------------------------------------------------
// The menu bar icon
// ---------------------------------------------------------------------------

function createTray(): Tray {
  // "…Template" in the name: macOS draws it black or white to suit the menu bar.
  const icon = new Tray(nativeImage.createFromPath(join(__dirname, "trayTemplate.png")));
  icon.setToolTip("TOT");
  // Built on each click, so the status line is current.
  const open = () => void openTrayMenu();
  icon.on("click", open);
  icon.on("right-click", open);
  return icon;
}

async function openTrayMenu() {
  const mode = await accessMode(PORT);
  const status = mode !== null ? accessLabel(mode) : launching ? "TOT is starting…" : "TOT isn't running";
  tray?.popUpContextMenu(
    Menu.buildFromTemplate([
      { label: "Open TOT", click: () => void showWindow() },
      { label: status, enabled: false },
      { type: "separator" },
      {
        label: "Open at login",
        type: "checkbox",
        checked: openAtLogin(),
        enabled: app.isPackaged,
        click: (item) => setOpenAtLogin(item.checked),
      },
      { label: "Show log", click: () => void shell.openPath(LOG_FILE) },
      { type: "separator" },
      { label: "Quit TOT", click: () => app.quit() },
    ]),
  );
}

// ---------------------------------------------------------------------------
// Open at login (the web app's Settings → General, and the menu bar menu)
// ---------------------------------------------------------------------------

function openAtLogin(): boolean {
  return app.isPackaged && app.getLoginItemSettings().openAtLogin;
}

/** Only the installed app: from a checkout this would add Electron's own app to Login Items. */
function setOpenAtLogin(open: boolean): boolean {
  if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: open });
  return openAtLogin();
}

/** The bridge answers TOT's own pages only. */
function fromApp(event: IpcMainInvokeEvent) {
  if (!event.senderFrame || !isAppUrl(event.senderFrame.url, PORT)) throw new Error("Only TOT's own pages can ask this.");
}

ipcMain.handle("tot:get-open-at-login", (event) => {
  fromApp(event);
  return openAtLogin();
});
ipcMain.handle("tot:set-open-at-login", (event, open: unknown) => {
  fromApp(event);
  if (typeof open !== "boolean") throw new Error("Expected true or false.");
  return setOpenAtLogin(open);
});
/** The folder picker for a new project or repo: a sheet on the asking window, starting in the home folder. */
ipcMain.handle("tot:pick-folder", async (event) => {
  fromApp(event);
  const options: Electron.OpenDialogOptions = {
    title: "Choose a folder",
    buttonLabel: "Choose",
    defaultPath: homedir(),
    properties: ["openDirectory", "createDirectory"],
  };
  const window = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePaths } = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
  return canceled ? null : (filePaths[0] ?? null);
});

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  // TOT is already open: it shows its window (second-instance), and this copy leaves.
  app.quit();
} else {
  if (trimLog(LOG_FILE)) logLine(LOG_FILE, "The log passed 10 MB and was emptied.");
  environment = prepareEnvironment();
  app.on("second-instance", () => void showWindow());
  app.on("activate", () => void showWindow());
  // No window is no reason to quit: TOT lives in the menu bar.
  app.on("window-all-closed", () => {});

  // Quit stops the server we started (never one we only attached to) before the app goes.
  app.on("before-quit", (event) => {
    quitting = true;
    if (!server.running) return;
    event.preventDefault();
    saveWindow();
    win?.hide();
    tray?.destroy();
    tray = null;
    logLine(LOG_FILE, "Quitting: stopping the TOT server.");
    void server.stop().finally(() => app.quit());
  });
  // Ctrl+C on `npm run app:dev`, or a kill: quit properly, so the server goes too.
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => app.quit());

  void app.whenReady().then(() => {
    if (!app.isPackaged) app.dock?.setIcon(join(APP_DIR, "electron", "resources", "icon.png"));
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback, details) =>
      callback(PERMISSIONS.has(permission) && isAppUrl(details.requestingUrl, PORT)),
    );
    session.defaultSession.setPermissionCheckHandler((_contents, permission, origin) => PERMISSIONS.has(permission) && isAppUrl(origin, PORT));
    nativeTheme.on("updated", () => win?.setBackgroundColor(background()));
    Menu.setApplicationMenu(appMenu());
    win = createWindow(!(app.isPackaged && app.getLoginItemSettings().wasOpenedAtLogin));
    tray = createTray();
    void launch();
  });
}
