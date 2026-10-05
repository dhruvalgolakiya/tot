import { serve } from "@hono/node-server";
import { hostname } from "node:os";
import { stopCodex } from "./agent/providers/chatgpt.ts";
import { runRegistry } from "./agent/runs.ts";
import { scheduler } from "./agent/scheduler.ts";
import { wikiKeeper } from "./agent/wiki-keeper.ts";
import { createApp } from "./app.ts";
import { apps } from "./apps.ts";
import { computerManager } from "./computer/manager.ts";
import { ACCESS_TOKEN, DATA_DIR, HOST, LAN, PORT, TAILSCALE, VERSION } from "./config.ts";
import { mailboxes } from "./mail/mailbox.ts";
import { emailTasks } from "./mail/tasks.ts";
import { isLoopbackBind, lanUrls, tailscaleAddress } from "./net.ts";
import { relay } from "./devices/relay.ts";
import { webPort } from "./devices/identity.ts";
import { migrateRepoBrains } from "./projects/projects.ts";
import { tokenProblem } from "./session.ts";
import { slack } from "./slack.ts";
import { fanIn } from "./orchestration/fanin.ts";
import { taskFailover } from "./orchestration/failover.ts";
import { handoffs } from "./orchestration/handoff.ts";
import { taskNotifications } from "./tasks/notify.ts";
import { tasks } from "./tasks/tasks.ts";
import { chatWakes } from "./tasks/wake.ts";

// Never put TOT on the network without sign-in: it drives paid subscriptions and runs commands.
const exposed = LAN || TAILSCALE || !isLoopbackBind(HOST);
const accessProblem =
  exposed && !ACCESS_TOKEN
    ? "TOT_LAN / TOT_HOST would open TOT to other devices, but TOT_ACCESS_TOKEN is empty. Set one in .env first (e.g. `openssl rand -hex 16`)."
    : ACCESS_TOKEN && tokenProblem(ACCESS_TOKEN);
if (TAILSCALE && !tailscaleAddress()) console.warn("TOT_HOST=tailscale, but Tailscale isn't up: only this machine can open TOT until it is.");
if (accessProblem) {
  console.error(`\n✖ ${accessProblem}\n`);
  process.exit(1);
}

const app = createApp();

const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  const port = webPort();
  console.log(`TOT ${VERSION} · API on http://${HOST}:${info.port} · data in ${DATA_DIR}`);
  console.log(`Open the app at http://localhost:${port}`);
  if (LAN) for (const url of lanUrls(port, hostname())) console.log(`On your network:  ${url}`);
  if (TAILSCALE && tailscaleAddress()) console.log(`On your tailnet:  http://${tailscaleAddress()}:${port}`);
  if (ACCESS_TOKEN) console.log("Sign-in is on: use TOT_ACCESS_TOKEN from .env.");
});

// Repo brains learned before projects existed become GitHub projects (once).
migrateRepoBrains();
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
taskNotifications.start();
fanIn.start();
taskFailover.start();
handoffs.start();

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received, stopping runs…`);
  scheduler.stop();
  wikiKeeper.stop();
  relay.stopAll();
  emailTasks.stop();
  // Running tasks show as interrupted next time (and resume by themselves, unless that's turned off).
  tasks.shutdown();
  // Chats waiting to be told about their tasks get told after the restart.
  chatWakes.stop();
  runRegistry.stopAll();
  await Promise.allSettled([computerManager.shutdown(), stopCodex(), apps.stop({ keepEnabled: true }), slack.stop(), mailboxes.stopAll()]);
  server.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
