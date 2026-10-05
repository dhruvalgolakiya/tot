// The Mac app's helpers (roadmap module 08): the PATH it runs TOT with, the node/npm/npx shims, whether to open
// a TOT already on the port or start one, where the window opens, which links stay in it, and the log's size cap.
// Run: TOT_DATA_DIR=$(mktemp -d) npx tsx electron/desktop.test.ts
import "../server/test-data-dir.ts"; // first: refuses to run against the real ~/.tot
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accessLabel, classifyAnswer, planLaunch, probeTot } from "./probe.ts";
import { trimLog } from "./server-process.ts";
import { EXTRA_DIRS, mergePath, parseShellPath, shellQuote, shimScripts, writeShims } from "./shell-env.ts";
import { DEFAULT_SIZE, isAppUrl, isExternalUrl, MIN_SIZE, placeWindow } from "./window-rules.ts";

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail.slice(0, 200)}` : ""}`);
}

const scratch = mkdtempSync(join(tmpdir(), "tot-desktop-test-"));

// --- PATH -----------------------------------------------------------------------------------------------------
console.log("# PATH");
check("the PATH between the markers", parseShellPath("Last login: today\n__TOT_PATH_START__/a:/b__TOT_PATH_END__\nbye") === "/a:/b");
check("no markers, no PATH", parseShellPath("zsh: command not found") === null);
check("a start marker alone isn't enough", parseShellPath("__TOT_PATH_START__/a:/b") === null);
check("an empty PATH counts as none", parseShellPath("__TOT_PATH_START____TOT_PATH_END__") === null);

const SHIMS = "/Users/me/Library/Application Support/TOT/bin";
const LAUNCHD = "/usr/bin:/bin:/usr/sbin:/sbin";
const merged = mergePath({ shellPath: "/Users/me/.nvm/bin:/opt/homebrew/bin:/usr/bin:/bin", currentPath: LAUNCHD, shimDir: SHIMS }).split(":");
check("the login shell's order comes first", merged.slice(0, 4).join(":") === "/Users/me/.nvm/bin:/opt/homebrew/bin:/usr/bin:/bin", merged.join(":"));
check("…then what launchd gave, without repeats", merged.filter((d) => d === "/usr/bin").length === 1 && merged.includes("/usr/sbin") && merged.includes("/sbin"));
check("…Homebrew's folders are always there", EXTRA_DIRS.every((d) => merged.includes(d)));
check("…and the shims come last, so the user's own node wins", merged.at(-1) === SHIMS && merged.indexOf(SHIMS) === merged.length - 1);
const fallback = mergePath({ shellPath: null, currentPath: LAUNCHD, shimDir: SHIMS }).split(":");
check("without the shell, Homebrew comes before the system folders", fallback.join(":") === `/opt/homebrew/bin:/usr/local/bin:${LAUNCHD}:${SHIMS}`, fallback.join(":"));
const again = mergePath({ shellPath: `${SHIMS}:/opt/homebrew/bin`, currentPath: `${LAUNCHD}:${SHIMS}`, shimDir: SHIMS }).split(":");
check("shims already on PATH move to the end, once", again.filter((d) => d === SHIMS).length === 1 && again.at(-1) === SHIMS, again.join(":"));
check("an empty or missing PATH still works", mergePath({ shellPath: null, currentPath: undefined, shimDir: SHIMS }) === `/opt/homebrew/bin:/usr/local/bin:${SHIMS}`);

// --- Shims ----------------------------------------------------------------------------------------------------
console.log("\n# Shims");
check("quoting a plain path", shellQuote("/Applications/TOT.app") === "'/Applications/TOT.app'");
check("quoting a path with a quote", shellQuote("/Users/me/Dhruval's apps") === `'/Users/me/Dhruval'\\''s apps'`);
const texts = shimScripts("/Applications/TOT.app/Contents/MacOS/TOT", "/Applications/TOT.app/Contents/Resources/app/node_modules/npm/bin");
check("node runs TOT.app as Node", texts.node.startsWith("#!/bin/sh\n") && texts.node.includes(`ELECTRON_RUN_AS_NODE=1 exec '/Applications/TOT.app/Contents/MacOS/TOT' "$@"`));
check("npm runs the bundled npm", texts.npm.includes(`'/Applications/TOT.app/Contents/Resources/app/node_modules/npm/bin/npm-cli.js' "$@"`));
check("npx runs the bundled npx", texts.npx.includes(`/npm/bin/npx-cli.js' "$@"`));

// Real shims, with a stand-in for TOT.app in a folder whose name needs quoting: it prints its environment
// flag and its arguments, one per line.
const odd = join(scratch, "Dhruval's \"apps\" $HOME");
mkdirSync(join(odd, "npm", "bin"), { recursive: true });
const fakeTot = join(odd, "TOT");
writeFileSync(fakeTot, `#!/bin/sh\necho "flag=$ELECTRON_RUN_AS_NODE"\nfor arg in "$@"; do echo "arg=$arg"; done\n`, { mode: 0o755 });
const shimDir = join(scratch, "bin");
writeShims(shimDir, fakeTot, join(odd, "npm", "bin"));
const run = (name: string, ...args: string[]) => execFileSync(join(shimDir, name), args, { encoding: "utf8", env: { PATH: "/usr/bin:/bin" } }).trim().split("\n");
const nodeOut = run("node", "-e", "console.log('hi there')");
check("the node shim sets ELECTRON_RUN_AS_NODE=1 for TOT.app", nodeOut[0] === "flag=1", nodeOut.join(" | "));
check("…and passes arguments through untouched", nodeOut[1] === "arg=-e" && nodeOut[2] === "arg=console.log('hi there')", nodeOut.join(" | "));
const npmOut = run("npm", "-v");
check("the npm shim runs npm-cli.js from an awkward path", npmOut[1] === `arg=${join(odd, "npm", "bin", "npm-cli.js")}` && npmOut[2] === "arg=-v", npmOut.join(" | "));
check("shims are executable", (statSync(join(shimDir, "npx")).mode & 0o111) === 0o111);
writeShims(shimDir, "/Applications/Moved/TOT.app/Contents/MacOS/TOT", join(odd, "npm", "bin"));
check("a later launch rewrites them (the app moved)", readFileSync(join(shimDir, "node"), "utf8").includes("/Applications/Moved/TOT.app"));

// --- Attach or start ------------------------------------------------------------------------------------------
console.log("\n# Attach or start");
const tot = classifyAnswer(200, JSON.stringify({ id: "d1", name: "Mac mini", protocol: 1 }));
check("TOT's /.well-known/tot is TOT", tot.kind === "tot" && tot.name === "Mac mini");
check("a web page isn't", classifyAnswer(200, "<!doctype html><title>Grafana</title>").kind === "other");
check("JSON without TOT's fields isn't", classifyAnswer(200, JSON.stringify({ id: 1, ok: true })).kind === "other");
check("a 404 isn't", classifyAnswer(404, JSON.stringify({ id: "d1", name: "x", protocol: 1 })).kind === "other");
check("TOT there: open it", planLaunch(tot) === "attach");
check("nothing there: start one", planLaunch({ kind: "free" }) === "start");
check("something else there: say so", planLaunch({ kind: "other", detail: "" }) === "blocked");

const listen = (handler: Parameters<typeof createServer>[1]) =>
  new Promise<Server>((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
const portOf = (server: Server) => (server.address() as AddressInfo).port;
const fakeTotServer = await listen((req, res) => {
  if (req.url === "/.well-known/tot") res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: "abc", name: "Test Mac", protocol: 1 }));
  else res.writeHead(404).end();
});
const otherServer = await listen((_req, res) => res.writeHead(200, { "content-type": "text/html" }).end("<h1>Someone else</h1>"));
const silentServer = await listen(() => {
  // Takes the connection and never answers.
});
const live = await probeTot(portOf(fakeTotServer));
check("a running TOT is found over HTTP", live.kind === "tot" && live.id === "abc", JSON.stringify(live));
check("another program on the port is told apart", (await probeTot(portOf(otherServer))).kind === "other");
check("a program that never answers is something else, not free", (await probeTot(portOf(silentServer), 300)).kind === "other");
const freePort = portOf(otherServer);
await new Promise((resolve) => otherServer.close(resolve));
const closed = await probeTot(freePort);
check("a closed port is free", closed.kind === "free", JSON.stringify(closed));
fakeTotServer.close();
silentServer.closeAllConnections();
silentServer.close();

check("menu bar: remote access off", accessLabel("off") === "Remote access: off");
check("menu bar: on this Wi‑Fi", accessLabel("lan") === "Remote access: on · this Wi‑Fi");
check("menu bar: on Tailscale", accessLabel("tailscale") === "Remote access: on · Tailscale");
check("menu bar: no answer", accessLabel(null) === "Remote access: unknown");

// --- The window -----------------------------------------------------------------------------------------------
console.log("\n# The window");
const laptop = { x: 0, y: 25, width: 1512, height: 920 };
const external = { x: 1512, y: 0, width: 2560, height: 1415 };
const first = placeWindow(null, [laptop], laptop);
check(
  "first launch: the default size, centred",
  first.width === DEFAULT_SIZE.width && first.height === DEFAULT_SIZE.height && first.x === 116 && first.y === 65,
  JSON.stringify(first),
);
const kept = placeWindow({ x: 1700, y: 100, width: 1400, height: 900 }, [laptop, external], laptop);
check("a saved place on the second screen is kept", kept.x === 1700 && kept.y === 100 && kept.width === 1400 && kept.height === 900, JSON.stringify(kept));
const unplugged = placeWindow({ x: 1700, y: 100, width: 1400, height: 900 }, [laptop], laptop);
check(
  "its screen unplugged: back on the main screen, centred, shrunk to fit",
  unplugged.x >= laptop.x && unplugged.x + unplugged.width <= laptop.x + laptop.width && unplugged.y >= laptop.y && unplugged.height <= laptop.height,
  JSON.stringify(unplugged),
);
const hanging = placeWindow({ x: 1000, y: 600, width: 1280, height: 840 }, [laptop], laptop);
check(
  "hanging off the edge: moved inside the screen",
  hanging.x + hanging.width <= laptop.x + laptop.width && hanging.y + hanging.height <= laptop.y + laptop.height && hanging.x >= 0,
  JSON.stringify(hanging),
);
const underMenuBar = placeWindow({ x: 100, y: 5, width: 1000, height: 700 }, [laptop], laptop);
check("a title bar under the menu bar can't be grabbed: re-centred", underMenuBar.y >= laptop.y, JSON.stringify(underMenuBar));
const tiny = placeWindow({ x: 10, y: 40, width: 300, height: 200 }, [laptop], laptop);
check("never smaller than the minimum (the phone layout starts below 768 px)", tiny.width === MIN_SIZE.width && tiny.height === MIN_SIZE.height, JSON.stringify(tiny));
const junk = placeWindow({ x: Number.NaN, width: "wide" as unknown as number }, [laptop], laptop);
check("a garbled saved state falls back to the default", junk.width === DEFAULT_SIZE.width && Number.isFinite(junk.x), JSON.stringify(junk));

check("TOT's own page stays in the window", isAppUrl("http://localhost:8787/chats/123", 8787));
check("…by 127.0.0.1 too", isAppUrl("http://127.0.0.1:8787/", 8787));
check("another port on this Mac (Executor, an agent's dev server) doesn't", !isAppUrl("http://localhost:4791/?_token=x", 8787));
check("a website doesn't", !isAppUrl("https://github.com/", 8787));
check("…nor HTTPS to the same port", !isAppUrl("https://localhost:8787/", 8787));
check("the browser opens web and mail links", isExternalUrl("https://github.com/") && isExternalUrl("mailto:me@example.com"));
check("…but not files or app schemes", !isExternalUrl("file:///etc/passwd") && !isExternalUrl("javascript:alert(1)") && !isExternalUrl("x-apple.systempreferences:"));

// --- Log ------------------------------------------------------------------------------------------------------
console.log("\n# Log");
const log = join(scratch, "server.log");
writeFileSync(log, "x".repeat(2048));
check("a small log is left alone", !trimLog(log, 4096) && statSync(log).size === 2048);
check("a log past the limit is emptied", trimLog(log, 1024) && statSync(log).size === 0);
check("no log yet is fine", !trimLog(join(scratch, "missing.log")));

rmSync(scratch, { recursive: true, force: true });
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
