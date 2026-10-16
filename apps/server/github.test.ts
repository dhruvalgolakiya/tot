// GitHub connection (app-wide and personas' own accounts) against a fake GitHub (API, device sign-in) and a
// fake `gh` CLI; agent computers are local.
// Run: TOT_DATA_DIR=$(mktemp -d) npx tsx server/github.test.ts
import "./test-data-dir.ts"; // first: refuses to run against the real ~/.tot
import { serve } from "@hono/node-server";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { Agent, AppEvent, GitHubStatus, Persona } from "../shared/types.ts";

const PORT = 8799;
const TOT_PORT = 8797; // pretend TOT runs here; agents' computers must not reach it
const AGENT_APP_PORT = 8796; // a server an agent started itself
const GOOD = "ghp_goodtoken123";
const CLI_TOKEN = "gho_clitoken456";
// A persona's own account (tot-agent). Short, so only the saved-token scrub can hide it, not the token pattern.
const PERSONA_TOKEN = "ghp_persona789";
const NO_REPO_TOKEN = "ghp_norepo000";
const FINE_GRAINED = "github_pat_fine111";
const revoked = new Set<string>();

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
    const token = (c.req.header("authorization") ?? "").replace(/^Bearer /, "");
    const totAgent = { login: "tot-agent", name: "Tot Agent", avatar_url: "https://avatars.example/tot-agent", id: 777001 };
    if (revoked.has(token)) return c.json({ message: "Bad credentials" }, 401);
    if (token === PERSONA_TOKEN || token === NO_REPO_TOKEN) {
      c.header("x-oauth-scopes", token === PERSONA_TOKEN ? "repo" : "read:user, gist");
      return c.json(totAgent);
    }
    if (token === FINE_GRAINED) return c.json(totAgent); // fine-grained tokens list no scopes
    if (![GOOD, CLI_TOKEN, "gho_devicetoken"].includes(token)) return c.json({ message: "Bad credentials" }, 401);
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
const { buildSystemPrompt, githubSection, githubStateLine } = await import("./agent/prompts.ts");
const { mcpServersFor, promptGitHubAccess } = await import("./agent/orchestrator.ts");
const { githubAccessFor, personaGitHub } = await import("./persona-github.ts");
const { personas } = await import("./data/personas.ts");
const { appEvents } = await import("./app-events.ts");
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

const prompt = buildSystemPrompt({ settings: settings.get(), workspace: null, agent, github: { login: "octocat", allowWrites: true, source: "user" } });
check("prompt has GitHub rules", prompt.includes("@octocat") && prompt.includes("Never push to the default branch"), "");
const readOnlyPrompt = buildSystemPrompt({ settings: settings.get(), workspace: null, agent, github: { login: "octocat", allowWrites: false, source: "user" } });
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

// --- A persona's own GitHub account -------------------------------------------------------------------------
// `agent` works as the user (octocat); `worker` works as the persona Tot, whose account is tot-agent.
const json = async <T>(res: Response) => (await res.json()) as T;
const events: AppEvent[] = [];
appEvents.subscribe((event) => events.push(event));
const githubSpec = (agentId: string) => {
  const spec = mcpServersFor({ id: "chat", agentId }, "claude").find((s) => s.name === "github");
  return spec?.type === "http" ? spec : null;
};
const credentials = (dir: string) => (existsSync(join(dir, ".git-credentials")) ? readFileSync(join(dir, ".git-credentials"), "utf8").trim() : "");
const pushBlocked = "git config --global --get-all url.https://pushing-is-off-in-tot-settings.invalid/.pushinsteadof | wc -l | tr -d ' '";

await github.connect({ method: "cli" });
active = await computerManager.ensure(agent.id);
const persona = await json<Persona>(await request("POST", "/personas", { name: "Tot", email: "tot.agent@example.com" }));
const mascot = { shape: "bot", color: "#60a5fa", accessory: "none", eyes: "dots" } as const;
const worker = await json<Agent>(await request("POST", "/agents", { name: "Totbot", mascot, personaId: persona.id }));
let mine = await computerManager.ensure(worker.id);
const workerHome = mine.backend.home(mine.externalId);
const run = async (command: string) => (await mine.backend.exec(mine.externalId, command, { timeoutMs: 30_000 })).stdout.trim();
check("persona without GitHub: its agent uses the user's account", githubAccessFor(worker.id)?.source === "user" && credentials(workerHome).startsWith("https://octocat:"));
const frozen = buildSystemPrompt({ settings: settings.get(), workspace: null, agent: worker, github: promptGitHubAccess(worker.id) });
check("…and its prompt says GitHub work shows up as the user", frozen.includes("(the user's account), read-only") && frozen.includes("shows up as the user"));

let res = await request("PUT", `/personas/${persona.id}/github`, { token: "ghp_wrong" });
check("persona: a bad token is a 400 with the reason", res.status === 400 && /didn't accept/.test((await json<{ error: string }>(res)).error));
res = await request("PUT", `/personas/${persona.id}/github`, { token: NO_REPO_TOKEN });
const noRepo = (await json<{ error: string }>(res)).error;
check("persona: a classic token without repo is refused", res.status === 400 && noRepo.includes('"repo" scope') && !noRepo.includes(NO_REPO_TOKEN), noRepo);
res = await request("PUT", `/personas/${persona.id}/github`, { token: CLI_TOKEN });
check("persona: the user's own account is refused", res.status === 400 && /your own account/.test((await json<{ error: string }>(res)).error));
res = await request("PUT", `/personas/${persona.id}/github`, { token: FINE_GRAINED });
check("persona: a fine-grained token is accepted", res.ok && (await json<Persona>(res)).github?.login === "tot-agent");

events.length = 0;
res = await request("PUT", `/personas/${persona.id}/github`, { token: PERSONA_TOKEN });
const connectedText = await res.text();
let connected = JSON.parse(connectedText) as Persona;
const g = connected.github;
check(
  "persona: connect stores login, name and avatar; read-only to start",
  res.ok && g?.login === "tot-agent" && g.name === "Tot Agent" && g.avatarUrl === "https://avatars.example/tot-agent" && !g.allowWrites && g.problem === null,
  connectedText,
);
check("persona: the token is never sent back", !connectedText.includes(PERSONA_TOKEN) && !JSON.stringify(await json(await request("GET", "/personas"))).includes(PERSONA_TOKEN));
check("persona: token stored privately under its own name", JSON.parse(readFileSync(paths.secrets, "utf8"))[`personaGitHubToken:${persona.id}`] === PERSONA_TOKEN);
check("persona: a persona event is published", events.some((e) => e.type === "persona" && e.persona.id === persona.id && e.persona.github?.login === "tot-agent"));
check("persona tokens hidden from agents too", redactGitHubTokens(`a ${PERSONA_TOKEN} b`) === "a [GitHub token hidden] b");

// Which account each agent uses, everywhere: GitHub tools, its computer, its prompt.
check("decision: the persona's agent uses the persona's account", githubAccessFor(worker.id)?.source === "persona" && githubAccessFor(worker.id)?.login === "tot-agent");
let spec = githubSpec(worker.id);
check(
  "MCP: the persona's token, read-only",
  spec?.headers?.Authorization === `Bearer ${PERSONA_TOKEN}` && spec.url.endsWith("/readonly") && spec.headers["X-MCP-Readonly"] === "true" && !spec.disabledTools,
);
check("MCP: an agent working as the user keeps the user's token", githubSpec(agent.id)?.headers?.Authorization === `Bearer ${CLI_TOKEN}`);
await sleep(100);
check("connecting logs the persona's computers out of the user's account right away", credentials(workerHome) === "");
check("…and leaves the user's agents' computers alone", credentials(home) === `https://octocat:${CLI_TOKEN}@github.com`);
mine = await computerManager.ensure(worker.id);
check("computer: git logged in as the persona's account", credentials(workerHome) === `https://tot-agent:${PERSONA_TOKEN}@github.com`);
check(
  "computer: read-only means gh logged out and pushes blocked",
  !existsSync(join(workerHome, ".config/gh/hosts.yml")) && (await run('echo "${GH_TOKEN:-none}"')) === "none" && (await run(pushBlocked)) !== "0",
);
check("computer: commits still authored as the persona", (await run("git config --global user.name")) === "Tot" && (await run("git config --global user.email")) === "tot.agent@example.com");
const personaPrompt = githubSection(promptGitHubAccess(worker.id), true);
check("prompt: names the persona's account", personaPrompt.includes("You use the GitHub account @tot-agent (this persona's") && personaPrompt.includes("(your persona's own account), read-only"));
check("prompt: a chat frozen before learns about the change", !frozen.includes(githubStateLine(promptGitHubAccess(worker.id))));
check("prompt: an agent working as the user is unchanged", githubSection(promptGitHubAccess(agent.id), true).includes("connected as @octocat, read-only. This is the user's own account."));

// Writes.
check("writes switch validated", (await request("PATCH", `/personas/${persona.id}/github`, { allowWrites: "yes" })).status === 400);
connected = await json<Persona>(await request("PATCH", `/personas/${persona.id}/github`, { allowWrites: true }));
spec = githubSpec(worker.id);
check(
  "writes on: GitHub tools can write, minus the blocked ones",
  connected.github?.allowWrites === true && !spec?.url.endsWith("readonly") && !spec?.headers?.["X-MCP-Readonly"] && Boolean(spec?.disabledTools?.includes("merge_pull_request")),
);
mine = await computerManager.ensure(worker.id);
check(
  "writes on: gh logged in as the persona, push block lifted",
  readFileSync(join(workerHome, ".config/gh/hosts.yml"), "utf8").includes(`oauth_token: ${PERSONA_TOKEN}`) &&
    (await run('echo "$GH_TOKEN"')) === PERSONA_TOKEN &&
    (await run(pushBlocked)) === "0",
);
check("…while the user's agent stays read-only", Boolean(githubSpec(agent.id)?.url.endsWith("/readonly")));
connected = await json<Persona>(await request("PATCH", `/personas/${persona.id}/github`, { allowWrites: false }));
mine = await computerManager.ensure(worker.id);
check(
  "writes off again: read-only and pushes blocked",
  !connected.github?.allowWrites && Boolean(githubSpec(worker.id)?.url.endsWith("/readonly")) && !existsSync(join(workerHome, ".config/gh/hosts.yml")) && (await run(pushBlocked)) !== "0",
);

// GitHub stops accepting the token.
revoked.add(PERSONA_TOKEN);
events.length = 0;
await personaGitHub.check(persona.id, { force: true });
const listed = (await json<Persona[]>(await request("GET", "/personas"))).find((p) => p.id === persona.id);
check("a revoked token shows a problem", Boolean(listed?.github?.problem), JSON.stringify(listed?.github));
check("…and publishes a persona event", events.some((e) => e.type === "persona" && e.persona.id === persona.id && Boolean(e.persona.github?.problem)));
revoked.delete(PERSONA_TOKEN);
await personaGitHub.check(persona.id, { force: true });
check("…cleared once GitHub accepts it again", personas.get(persona.id)?.github?.problem === null);

// The user's agent switches to the persona, and back.
await request("PATCH", `/agents/${agent.id}`, { personaId: persona.id });
await sleep(100);
check("switching an agent to the persona takes the user's login off its computer", credentials(home) === "");
active = await computerManager.ensure(agent.id);
check("…and logs it in as the persona's account", credentials(home) === `https://tot-agent:${PERSONA_TOKEN}@github.com` && (await sh("git config --global user.email")) === "tot.agent@example.com");
await request("PATCH", `/agents/${agent.id}`, { personaId: null });
active = await computerManager.ensure(agent.id);
check(
  "back to working as the user: the user's login and author",
  credentials(home) === `https://octocat:${CLI_TOKEN}@github.com` && (await sh("git config --global user.email")) === "583231+octocat@users.noreply.github.com",
);

// Disconnect: back to the user's account.
events.length = 0;
connected = await json<Persona>(await request("DELETE", `/personas/${persona.id}/github`));
await sleep(100);
check("disconnect forgets the token", connected.github === null && !readFileSync(paths.secrets, "utf8").includes(PERSONA_TOKEN));
check("…publishes a persona event", events.some((e) => e.type === "persona" && e.persona.id === persona.id && e.persona.github === null));
check("…and logs the persona's computers out right away", credentials(workerHome) === "");
check("disconnect falls back to the user's account", githubAccessFor(worker.id)?.source === "user" && githubSpec(worker.id)?.headers?.Authorization === `Bearer ${CLI_TOKEN}`);
mine = await computerManager.ensure(worker.id);
check(
  "…on the computer too, still authored as the persona",
  credentials(workerHome) === `https://octocat:${CLI_TOKEN}@github.com` && (await run("git config --global user.email")) === "tot.agent@example.com",
);
check("…and in the prompt", githubSection(promptGitHubAccess(worker.id), true).includes("shows up as the user"));

// Deleting the persona.
await request("PUT", `/personas/${persona.id}/github`, { token: PERSONA_TOKEN });
mine = await computerManager.ensure(worker.id);
check("reconnected for the delete test", credentials(workerHome).startsWith("https://tot-agent:"));
res = await request("DELETE", `/personas/${persona.id}`);
await sleep(100);
check("deleting the persona forgets its token", res.ok && !readFileSync(paths.secrets, "utf8").includes(`personaGitHubToken:${persona.id}`));
check("…takes its login off computers right away", credentials(workerHome) === "");
mine = await computerManager.ensure(worker.id);
check(
  "…and its agents fall back to the user's account and author",
  githubSpec(worker.id)?.headers?.Authorization === `Bearer ${CLI_TOKEN}` &&
    credentials(workerHome) === `https://octocat:${CLI_TOKEN}@github.com` &&
    (await run("git config --global user.email")) === "583231+octocat@users.noreply.github.com",
);
check("an agent working as the user was never affected", githubSpec(agent.id)?.headers?.Authorization === `Bearer ${CLI_TOKEN}` && credentials(home).startsWith("https://octocat:"));

await computerManager.destroy(worker.id);
agents.delete(worker.id);
await github.disconnect();
await computerManager.destroy(agent.id);
agents.delete(agent.id);
fakeServer.close();
fakeTot.close();
agentApp.close();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
