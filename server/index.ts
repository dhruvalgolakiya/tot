import { serve } from "@hono/node-server";
import { stopCodex } from "./agent/providers/chatgpt.ts";
import { runRegistry } from "./agent/runs.ts";
import { scheduler } from "./agent/scheduler.ts";
import { wikiKeeper } from "./agent/wiki-keeper.ts";
import { createApp } from "./app.ts";
import { apps } from "./apps.ts";
import { computerManager } from "./computer/manager.ts";
import { effectiveMode, signInReady } from "./access.ts";
import { ACCESS_TOKEN, DATA_DIR, ENV_REMOTE, HOST, PORT, RAW_HOST_EXPOSED, VERSION } from "./config.ts";
import { mailboxes } from "./mail/mailbox.ts";
import { emailTasks } from "./mail/tasks.ts";
import { appEvents } from "./app-events.ts";
import { relay } from "./devices/relay.ts";
import { addresses, selfDevice, webPort } from "./devices/identity.ts";
import { listeners } from "./listeners.ts";
import { migrateRepoBrains } from "./projects/projects.ts";
import { migrateProjectRepos } from "./projects/repos.ts";
import { startMemory, stopMemory } from "./memory/start.ts";
import { tokenProblem } from "./session.ts";
import { slack } from "./slack.ts";
import { fanIn } from "./orchestration/fanin.ts";
import { missionWatch } from "./mission/watch.ts";
import { taskFailover } from "./orchestration/failover.ts";
import { handoffs } from "./orchestration/handoff.ts";
import { taskNotifications } from "./tasks/notify.ts";
import { tasks } from "./tasks/tasks.ts";
import { chatWakes } from "./tasks/wake.ts";
import { worktreeLifecycle } from "./worktrees/lifecycle.ts";

// The Mac app (module 08) runs TOT with Electron's Node, which ELECTRON_RUN_AS_NODE=1 switches on. Children
// mustn't inherit it: an agent running another Electron app's CLI would get a bare Node instead.
delete process.env.ELECTRON_RUN_AS_NODE;

// Never put TOT on the network without sign-in: it drives paid subscriptions and runs commands. Remote
// access (Settings → Devices, or legacy TOT_LAN / TOT_HOST=tailscale) waits for a password by itself; only a
// TOT_HOST address puts the main listener out there, so that one needs sign-in before TOT starts.
const accessProblem =
  RAW_HOST_EXPOSED && !signInReady()
    ? `TOT_HOST=${HOST} would open TOT to other devices before it has a password. Start it without TOT_HOST and set one in Settings → Devices first (or set TOT_ACCESS_TOKEN).`
    : ACCESS_TOKEN && tokenProblem(ACCESS_TOKEN);
if (ENV_REMOTE && !signInReady()) console.warn(`${ENV_REMOTE.variable} is set, but there's no password yet: set one in Settings → Devices.`);
if (accessProblem) {
  console.error(`\n✖ ${accessProblem}\n`);
  process.exit(1);
}

const app = createApp();

const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  console.log(`TOT ${VERSION} · API on http://${HOST}:${info.port} · data in ${DATA_DIR}`);
  console.log(`Open the app at http://localhost:${webPort()}`);
  if (effectiveMode() === "off") console.log("Remote access: off. Turn it on in Settings → Devices to use TOT from your phone.");
});
// Read the peer's address as each connection opens, so a request never finds it gone (auth.ts trusts it).
server.on("connection", (socket) => void socket.remoteAddress);

// Remote access (module 07): listeners on the Tailscale or home-network address, opened and closed as the
// setting and the network change. Every screen hears about it (the Devices page shows the address).
listeners.onChange(() => {
  for (const { url } of addresses()) console.log(`Other devices can open TOT at ${url}`);
  appEvents.publish({ type: "device", device: selfDevice() });
});
void listeners.start(app);

// Repo brains learned before projects existed become GitHub projects (once).
migrateRepoBrains();
// Workspaces (module 11): every project with code gets its repo or folder as its primary repo (once).
migrateProjectRepos();
// Memory repo (module 10): old memories become a git repo (once), the index is rebuilt; sync and Dreaming start.
void startMemory();
computerManager.startIdleReaper();
// Live links to paired devices (module 07): their agents show here, and they go online and offline.
relay.startAll();
scheduler.start();
void apps.resume();
void slack.resume();
emailTasks.start();
mailboxes.resume();
wikiKeeper.start();
// Before tasks: tasks cut off by the restart (and not resuming) wake the chats that started them.
chatWakes.start();
tasks.start();
// Module 09: previews from before the restart are gone, old worktrees are swept daily.
worktreeLifecycle.start();
taskNotifications.start();
fanIn.start();
missionWatch.start();
taskFailover.start();
handoffs.start();

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received, stopping runs…`);
  scheduler.stop();
  wikiKeeper.stop();
  stopMemory();
  relay.stopAll();
  void listeners.stop();
  emailTasks.stop();
  // Running tasks show as interrupted next time (and resume by themselves, unless that's turned off).
  tasks.shutdown();
  // Chats waiting to be told about their tasks get told after the restart.
  chatWakes.stop();
  runRegistry.stopAll();
  await Promise.allSettled([
    computerManager.shutdown(),
    worktreeLifecycle.shutdown(),
    stopCodex(),
    apps.stop({ keepEnabled: true }),
    slack.stop(),
    mailboxes.stopAll(),
  ]);
  server.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
