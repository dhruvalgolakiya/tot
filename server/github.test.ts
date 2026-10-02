// GitHub connection against a fake GitHub (API, device sign-in) and a fake `gh` CLI; agent computers are local.
// Run: TOT_DATA_DIR=$(mktemp -d) npx tsx server/github.test.ts
import "./test-data-dir.ts"; // first: refuses to run against the real ~/.tot
import { serve } from "@hono/node-server";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { GitHubStatus } from "../shared/types.ts";

const PORT = 8799;
const TOT_PORT = 8797; // pretend TOT runs here; agents' computers must not reach it
const AGENT_APP_PORT = 8796; // a server an agent started itself
const GOOD = "ghp_goodtoken123";
const CLI_TOKEN = "gho_clitoken456";

// A fake gh first on PATH, so the real one (and the real login) is never touched.
const bin = mkdtempSync(join(tmpdir(), "tot-gh-"));
writeFileSync(
  join(bin, "gh"),
  `#!/bin/sh
case "$1 $2" in
  "auth status") echo "github.com"; echo "  ✓ Logged in to github.com account octocat (keyring)"; echo "  - Active account: true";;
  "auth token") echo "${CLI_TOKEN}";;
  *) exit 1;;
esac
`,
);
chmodSync(join(bin, "gh"), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.TOT_GITHUB_API_URL = `http://127.0.0.1:${PORT}`;
process.env.TOT_GITHUB_WEB_URL = `http://127.0.0.1:${PORT}`;
process.env.TOT_GITHUB_CLIENT_ID = "test-client";
process.env.TOT_PORT = String(TOT_PORT);
process.env.TOT_ACCESS_TOKEN = ""; // empty overrides .env: no sign-in for this test

let devicePolls = 0;
const fake = new Hono()
  .get("/user", (c) => {
    const auth = c.req.header("authorization") ?? "";
    if (![`Bearer ${GOOD}`, `Bearer ${CLI_TOKEN}`, "Bearer gho_devicetoken"].includes(auth)) return c.json({ message: "Bad credentials" }, 401);
    c.header("x-oauth-scopes", "repo, read:org, workflow");
    return c.json({ login: "octocat", name: "The Octocat", avatar_url: "https://avatars.example/octocat", id: 583231 });
  })
  .get("/user/repos", (c) =>
    c.json([
      { full_name: "octocat/web", private: true, description: "Storefront", html_url: "https://github.com/octocat/web", pushed_at: "2026-09-30T10:00:00Z" },
      { full_name: "octocat/api", private: false, description: null, html_url: "https://github.com/octocat/api", pushed_at: null },
    ]),
  )
  .post("/login/device/code", (c) =>
    c.json({ device_code: "dev-123", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", expires_in: 900, interval: 1 }),
  )
  .post("/login/oauth/access_token", (c) =>
    c.json(++devicePolls < 2 ? { error: "authorization_pending" } : { access_token: "gho_devicetoken", token_type: "bearer" }),
  );
const fakeServer = serve({ fetch: fake.fetch, port: PORT, hostname: "127.0.0.1" });
const hello = new Hono().get("/", (c) => c.text("hello"));
const fakeTot = serve({ fetch: hello.fetch, port: TOT_PORT, hostname: "::" });
const agentApp = serve({ fetch: hello.fetch, port: AGENT_APP_PORT, hostname: "127.0.0.1" });

const { github, GitHubError, redactGitHubTokens } = await import("./github.ts");
const { validateRepoSource } = await import("./agent/learn-repo.ts");
const { paths } = await import("./config.ts");
const { settings } = await import("./data/settings.ts");
const { agents } = await import("./data/agents.ts");
const { computerManager } = await import("./computer/manager.ts");
const { buildSystemPrompt } = await import("./agent/prompts.ts");
const { createApp } = await import("./app.ts");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail.replace(/\n/g, " ⏎ ").slice(0, 170)}` : ""}`);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let status = await github.status();
check("not connected; sees gh login and browser sign-in", !status.connection && status.cli?.login === "octocat" && status.oauthAvailable, JSON.stringify(status));

const rejected = await github.connect({ method: "token", token: "ghp_wrong" }).catch((err: unknown) => err);
check("bad token is refused", rejected instanceof GitHubError && /didn't accept/.test(String(rejected)), String(rejected));

status = await github.connect({ method: "cli" });
check("connect with gh login", status.connection?.login === "octocat" && status.connection.source === "cli" && status.connection.scopes.includes("repo"));
check("token stored privately", (statSync(paths.secrets).mode & 0o777) === 0o600 && readFileSync(paths.secrets, "utf8").includes(CLI_TOKEN));

const app = createApp();
const request = (method: string, path: string, body?: unknown) =>
  app.request(`http://localhost:8787/api${path}`, {
    method,
    headers: { Host: "localhost:8787", Origin: "http://localhost:8787", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const statusText = await (await request("GET", "/github")).text();
check("token never sent to the browser", !statusText.includes(CLI_TOKEN) && statusText.includes("octocat"), statusText);
const repos = (await (await request("GET", "/github/repos?q=store")).json()) as { fullName: string; private: boolean }[];
check("repos filtered by query", repos.length === 1 && repos[0]!.fullName === "octocat/web" && repos[0]!.private);
const badPatch = await request("PATCH", "/github", { allowWrites: "yes" });
check("writes switch validated", badPatch.status === 400);

// Agent computers: logged in as the account, commits attributed, pushes blocked while writes are off.
settings.patch({ computer: { mode: "local" } });
const agent = agents.create({ name: "Coder", mascot: { shape: "bot", color: "#60a5fa", accessory: "none", eyes: "dots" } });
let active = await computerManager.ensure(agent.id);
const sh = async (command: string) => (await active.backend.exec(active.externalId, command, { timeoutMs: 30_000 })).stdout.trim();
const home = active.backend.home(active.externalId);
check("git credentials written", readFileSync(join(home, ".git-credentials"), "utf8").trim() === `https://octocat:${CLI_TOKEN}@github.com`);
check("credentials are private", (statSync(join(home, ".git-credentials")).mode & 0o777) === 0o600);
check("gh logged out while read-only", !existsSync(join(home, ".config/gh/hosts.yml")) && (await sh('echo "${GH_TOKEN:-none}"')) === "none");
check("commits attributed", (await sh("git config --global user.email")) === "583231+octocat@users.noreply.github.com");
const push = await active.backend.exec(
  active.externalId,
  "rm -rf r && git init -q r && cd r && git remote add origin https://github.com/octocat/web && git commit -q --allow-empty -m x && git push origin HEAD 2>&1; true",
  { timeoutMs: 30_000 },
);
check("push blocked while writes are off", push.stdout.includes("pushing-is-off-in-tot-settings.invalid"), push.stdout);
const pushForms = await sh(
  "cd r && for u in https://github.com:443/o/r https://octocat@github.com/o/r ssh://git@github.com/o/r git@github.com:o/r; do git remote set-url origin $u; git remote get-url --push origin; done",
);
check("other push URL forms blocked too", pushForms.split("\n").every((url) => url.startsWith("https://pushing-is-off")), pushForms);
check("keychain helper reset", (await sh("git config --global --get-all credential.helper | tr '\\n' ,")) === ",store,");
const reachTot = await sh(`curl -s -m 3 http://127.0.0.1:${TOT_PORT}/ || echo blocked; curl -s -g -m 3 'http://[::1]:${TOT_PORT}/' || echo blocked`);
check("sandbox can't reach TOT's own server", reachTot === "blocked\nblocked", reachTot);
check("sandbox still reaches the agent's own servers", (await sh(`curl -s -m 3 http://127.0.0.1:${AGENT_APP_PORT}/`)) === "hello");
check("tokens hidden from agents", redactGitHubTokens(`x ${CLI_TOKEN} y ghp_${"a".repeat(36)}`) === "x [GitHub token hidden] y [GitHub token hidden]");

status = await github.setAllowWrites(true);
active = await computerManager.ensure(agent.id);
check("writes on lifts the block", status.allowWrites && (await sh("git config --global --get-all url.https://pushing-is-off-in-tot-settings.invalid/.pushinsteadof; true")) === "");
check("gh logged in while writes are on", readFileSync(join(home, ".config/gh/hosts.yml"), "utf8").includes(`oauth_token: ${CLI_TOKEN}`) && (await sh('echo "${GH_TOKEN:+set}"')) === "set");

const prompt = buildSystemPrompt({ settings: settings.get(), workspace: null, agent, github: { login: "octocat", allowWrites: true } });
check("prompt has GitHub rules", prompt.includes("@octocat") && prompt.includes("Never push to the default branch"), "");
const readOnlyPrompt = buildSystemPrompt({ settings: settings.get(), workspace: null, agent, github: { login: "octocat", allowWrites: false } });
check("read-only prompt", readOnlyPrompt.includes("You're read-only"), "");

status = (await (await request("DELETE", "/github")).json()) as GitHubStatus;
await sleep(200);
check("disconnect forgets the token", !status.connection && !readFileSync(paths.secrets, "utf8").includes(CLI_TOKEN));
check("disconnect logs computers out right away", !existsSync(join(home, ".git-credentials")));
active = await computerManager.ensure(agent.id);
check("computer logged out", !existsSync(join(home, ".git-credentials")) && !existsSync(join(home, ".config/gh/hosts.yml")) && (await sh("git config --global credential.helper; true")) === "");
check("no gh token in env after disconnect", (await sh('echo "${GH_TOKEN:-none}"')) === "none");

// Browser sign-in (device flow).
const started = await github.startDevice();
check("device sign-in starts", started.userCode === "ABCD-1234" && started.intervalSeconds === 1);
let poll = await github.pollDevice();
check("waits for the interval", poll.state === "pending" && devicePolls === 0);
for (let i = 0; i < 5 && poll.state === "pending"; i++) {
  await sleep(1100);
  poll = await github.pollDevice();
}
check("device sign-in connects", poll.state === "connected" && poll.status?.connection?.source === "oauth", JSON.stringify(poll));
check("connecting after a disconnect starts read-only", poll.status?.allowWrites === false);

// Disconnecting while a sign-in poll is in flight must not reconnect.
await github.disconnect();
devicePolls = 0;
await github.startDevice();
await sleep(1100);
devicePolls = 1; // the next answer from the fake is a token
const inFlight = github.pollDevice();
await github.disconnect();
const raced = await inFlight;
check("disconnect wins over an in-flight sign-in", raced.state === "none" && !(await github.status()).connection, JSON.stringify(raced));

const refused = (() => {
  try {
    validateRepoSource("https://octocat:ghp_secret@github.com/o/r");
    return false;
  } catch {
    return true;
  }
})();
check("learn-repo refuses URLs with logins", refused && validateRepoSource("ssh://git@github.com/o/r") === "ssh://git@github.com/o/r");

await github.disconnect();
await computerManager.destroy(agent.id);
agents.delete(agent.id);
fakeServer.close();
fakeTot.close();
agentApp.close();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
