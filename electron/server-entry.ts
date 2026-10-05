import "../server/index.ts";

/**
 * The TOT server as the Mac app runs it (roadmap module 08), bundled into dist-app/server.mjs: the same server
 * as `npm start`, plus a watch on the app. If the app goes away without stopping it (a crash, Force Quit),
 * launchd adopts the server, and it shuts itself down instead of holding on to the port and the agents'
 * processes.
 */

const parent = process.ppid;
setInterval(() => {
  if (process.ppid !== parent) process.kill(process.pid, "SIGTERM");
}, 2000).unref();
