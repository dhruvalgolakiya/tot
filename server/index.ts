import { serve } from "@hono/node-server";
import { hostname } from "node:os";
import { stopCodex } from "./agent/providers/chatgpt.ts";
import { runRegistry } from "./agent/runs.ts";
import { scheduler } from "./agent/scheduler.ts";
import { wikiKeeper } from "./agent/wiki-keeper.ts";
import { createApp } from "./app.ts";
import { apps } from "./apps.ts";
import { computerManager } from "./computer/manager.ts";
import { ACCESS_TOKEN, DATA_DIR, HOST, IS_PROD, LAN, PORT, VERSION } from "./config.ts";
import { isLoopbackBind, lanUrls } from "./net.ts";
import { tokenProblem } from "./session.ts";
import { slack } from "./slack.ts";

// Never put TOT on the network without sign-in: it drives paid subscriptions and runs commands.
const exposed = LAN || !isLoopbackBind(HOST);
const accessProblem =
  exposed && !ACCESS_TOKEN
    ? "TOT_LAN / TOT_HOST would open TOT to other devices, but TOT_ACCESS_TOKEN is empty. Set one in .env first (e.g. `openssl rand -hex 16`)."
    : ACCESS_TOKEN && tokenProblem(ACCESS_TOKEN);
if (accessProblem) {
  console.error(`\n✖ ${accessProblem}\n`);
  process.exit(1);
}

const app = createApp();

const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  const webPort = IS_PROD ? info.port : 5173;
  console.log(`TOT ${VERSION} · API on http://${HOST}:${info.port} · data in ${DATA_DIR}`);
  console.log(`Open the app at http://localhost:${webPort}`);
  if (LAN) for (const url of lanUrls(webPort, hostname())) console.log(`On your network:  ${url}`);
  if (ACCESS_TOKEN) console.log("Sign-in is on: use TOT_ACCESS_TOKEN from .env.");
});

computerManager.startIdleReaper();
scheduler.start();
void apps.resume();
void slack.resume();
wikiKeeper.start();

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received, stopping runs…`);
  scheduler.stop();
  wikiKeeper.stop();
  runRegistry.stopAll();
  await Promise.allSettled([computerManager.shutdown(), stopCodex(), apps.stop({ keepEnabled: true }), slack.stop()]);
  server.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
