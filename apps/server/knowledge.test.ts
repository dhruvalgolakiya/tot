// One knowledge base (roadmap module 11, lane B): every brain's wiki moves into a git repo of markdown, a project's
// beside its memory. The one-time move of a seeded wiki (pages, nesting, the pinned Overview, revisions, a deleted
// page, a secret) with ids and authors kept and the old rows kept as *_legacy; a move that fails falls back to the
// database and is tried again; every `wiki.*` call on git; history from git (bursts, ids that survive the commit,
// "Before git"), restore and undo; secrets refused; memory's facts ignore pages/ and repos/; hand edits read back;
// a repo's docs (head pages, repos/<name>/) and Learn a repo for a project repo; one commit per batch; a brain that
// joins a project brings its pages; 20 parallel writers beside memory; the knowledge routes.
// Run: TOT_DATA_DIR=$(mktemp -d) npx tsx apps/server/knowledge.test.ts
import "./test-data-dir.ts"; // first: refuses to run against the real ~/.tot
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// --- Before the wiki loads: a database from before module 11, with a wiki in its tables -------------------------
const { db } = await import("./db.ts");
const day = Date.UTC(2026, 6, 1, 12);
const mascot = JSON.stringify({ shape: "blob", color: "#60a5fa", accessory: "none", eyes: "dots" });
const ids = {
  agent: randomUUID(),
  notebook: randomUUID(),
  shopBrain: randomUUID(),
  shop: randomUUID(),
  brokenBrain: randomUUID(),
  broken: randomUUID(),
  overview: randomUUID(),
  web: randomUUID(),
  architecture: randomUUID(),
  deploys: randomUUID(),
  gone: randomUUID(),
  secret: randomUUID(),
  nbOverview: randomUUID(),
  brokenOverview: randomUUID(),
  brokenPage: randomUUID(),
};
db.prepare(`INSERT INTO agents (id, name, mascot, instructions, model_id, created_at, updated_at) VALUES (?, 'Kiwi', ?, '', 'auto', ?, ?)`).run(ids.agent, mascot, day, day);
const brain = db.prepare(`INSERT INTO brains (id, name, kind, description, owner_agent_id, all_agents, created_at, updated_at) VALUES (?, ?, ?, '', ?, ?, ?, ?)`);
brain.run(ids.notebook, "Notebook", "notebook", ids.agent, 0, day, day);
brain.run(ids.shopBrain, "Shop", "notes", null, 1, day, day);
brain.run(ids.brokenBrain, "Broken", "notes", null, 1, day, day);
const project = db.prepare(`INSERT INTO projects (id, name, slug, kind, brain_id, created_at, updated_at) VALUES (?, ?, ?, 'none', ?, ?, ?)`);
project.run(ids.shop, "Shop", "shop", ids.shopBrain, day, day);
project.run(ids.broken, "Broken", "broken", ids.brokenBrain, day, day);
const page = db.prepare(
  `INSERT INTO wiki_pages (id, brain_id, parent_id, title, summary, content, pinned, position, updated_by, conversation_id, created_at, updated_at, deleted_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
);
page.run(ids.overview, ids.shopBrain, null, "Overview", "Start here", "The shop: a storefront and its API.", 1, 0, "user", null, day, day + 5, null);
page.run(ids.web, ids.shopBrain, null, "web", "The storefront", "Next.js storefront.\n\n- Run `pnpm i` first.\n- Prices are cents.", 0, 1, "keeper", "chat-before", day + 1, day + 6, null);
page.run(ids.architecture, ids.shopBrain, ids.web, "Architecture", "How web fits together", "Pages call the API through `lib/client.ts`.", 0, 1, "agent", "chat-before", day + 2, day + 7, null);
page.run(ids.deploys, ids.shopBrain, null, "Run, test & deploy", "Commands: setup, tests, deploys", "Deploy with `make ship`.", 0, 2, "agent", null, day + 3, day + 3, null);
page.run(ids.gone, ids.shopBrain, null, "Old notes", "Deleted before the move", "Kept in the legacy table.", 0, 3, "user", null, day, day, day + 8);
page.run(ids.secret, ids.shopBrain, null, "Keys", "A page an agent wrote a key into", "The API key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123 for now.\nThe staging password is Sunflower99!", 0, 4, "agent", null, day, day, null);
page.run(ids.nbOverview, ids.notebook, null, "Overview", "What this workspace is for", "Kiwi's notebook.", 1, 0, "agent", null, day, day + 1, null);
page.run(ids.brokenOverview, ids.brokenBrain, null, "Overview", "Start here", "", 1, 0, "agent", null, day, day, null);
page.run(ids.brokenPage, ids.brokenBrain, null, "Plans", "What's next", "Ship the thing.", 0, 1, "user", null, day, day, null);
const revision = db.prepare(`INSERT INTO wiki_revisions (id, page_id, title, summary, content, updated_by, conversation_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
const oldRevisions = [randomUUID(), randomUUID()];
revision.run(oldRevisions[0], ids.web, "web", "The storefront", "Next.js storefront (first draft).", "agent", "chat-before", day + 2);
revision.run(oldRevisions[1], ids.web, "web", "The storefront", "Next.js storefront, second draft.", "agent", "chat-before", day + 4);

const { DATA_DIR } = await import("./config.ts");
// The broken brain's repo can't be made: something that isn't a folder is where it would go.
const brokenRepoDir = join(DATA_DIR, "memory", "projects", "broken");
mkdirSync(join(DATA_DIR, "memory", "projects"), { recursive: true });
writeFileSync(brokenRepoDir, "not a folder");

const { serve } = await import("@hono/node-server");
const { createApp } = await import("./app.ts");
const { settings } = await import("./data/settings.ts");
const { brains } = await import("./data/brains.ts");
const { conversations } = await import("./data/conversations.ts");
const { memories } = await import("./data/memories.ts");
const { wiki, WikiError, WIKI_SECRET_REFUSAL } = await import("./data/wiki.ts");
const { projects } = await import("./projects/projects.ts");
const { knowledge } = await import("./knowledge/index.ts");
const store = await import("./knowledge/store.ts");
const { renderPage } = await import("./knowledge/files.ts");
const { remember, repoFiles } = await import("./memory/memory.ts");
const repo = await import("./memory/repo.ts");
const { providers } = await import("./agent/providers/index.ts");
const { learnRepo } = await import("./agent/learn-repo.ts");
type AgentProvider = import("./agent/providers/types.ts").AgentProvider;
type TurnInput = import("./agent/providers/types.ts").TurnInput;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail.replace(/\n/g, " ⏎ ").slice(0, 240)}` : ""}`);
}
const g = (dir: string, ...args: string[]) => repo.git(dir, args);
const commits = async (dir: string) => Number((await g(dir, "rev-list", "--count", "HEAD")).trim());
const subjects = async (dir: string, n = 5) => (await g(dir, "log", `-n${n}`, "--format=%s")).trim().split("\n");
const read = (dir: string, path: string) => (existsSync(join(dir, path)) ? readFileSync(join(dir, path), "utf8") : null);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const shopDir = repo.repoDir("projects/shop");
const notebookDir = repo.repoDir(`brains/${ids.notebook}`);

settings.patch({ computer: { mode: "local" }, memory: { enabled: true } });

const turns: TurnInput[] = [];
function fakeProvider(id: "claude" | "chatgpt", label: string): AgentProvider {
  return {
    id,
    label,
    status: async () => ({ id, label, installed: true, loggedIn: true, models: [{ id: `${id}:m`, provider: id, model: "m", label: "m", available: true }] }),
    async *runTurn(input) {
      turns.push(input);
      yield { type: "session", sessionId: input.sessionId ?? `${id}-${randomUUID().slice(0, 8)}` };
      yield { type: "text-delta", blockId: "b1", delta: "Done." };
      yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
    },
    complete: async () => "A title",
  };
}
providers.claude = fakeProvider("claude", "Claude");
providers.chatgpt = fakeProvider("chatgpt", "ChatGPT");

const PORT = 19_000 + Math.floor(Math.random() * 900);
const server = serve({ fetch: createApp().fetch, port: PORT, hostname: "127.0.0.1" });
const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`http://127.0.0.1:${PORT}/api${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data, text };
};

try {
  // --- Before the move ------------------------------------------------------------------------------------------
  console.log("\n# Before the move, the wiki works from the database");
  check("old brains are in the database until they move", knowledge.mode(ids.shopBrain) === "database" && knowledge.mode(ids.notebook) === "database");
  check("…and read as before", wiki.get(ids.web)?.content.startsWith("Next.js storefront.") === true && wiki.list(ids.shopBrain).length === 5);

  // --- The move -------------------------------------------------------------------------------------------------
  console.log("\n# Moving a seeded wiki into git (and one that fails)");
  const first = await store.startStore();
  check("the shop and the notebook moved, the broken one failed", first.moved === 2 && first.failed.length === 1 && first.failed[0]!.brainId === ids.brokenBrain, JSON.stringify(first));
  check("a project's brain lives in the project's knowledge repo, beside its memory", existsSync(join(shopDir, ".git")) && existsSync(join(shopDir, "MEMORY.md")) && knowledge.repoFor(ids.shopBrain) === "projects/shop");
  check("any other brain in a repo of its own", existsSync(join(notebookDir, "pages", "overview.md")) && knowledge.repoFor(ids.notebook) === `brains/${ids.notebook}`);
  const overviewFile = read(shopDir, "pages/overview.md") ?? "";
  check("the Overview is pages/overview.md, pinned, its id kept", overviewFile.includes(`id: ${ids.overview}`) && overviewFile.includes("pinned: true") && overviewFile.includes("The shop: a storefront and its API."), overviewFile);
  const archFile = read(shopDir, "pages/architecture.md") ?? "";
  check("a nested page names its parent", archFile.includes(`parent: ${ids.web}`) && archFile.includes(`id: ${ids.architecture}`), archFile);
  const deployFile = read(shopDir, "pages/run-test-deploy.md") ?? "";
  check("other pages are pages/<slug>.md with front matter", deployFile.startsWith("---\n") && deployFile.includes('title: "Run, test & deploy"') && deployFile.includes("position: 2") && deployFile.endsWith("Deploy with `make ship`.\n"), deployFile);
  check("one commit: “Imported 5 wiki pages”", (await subjects(shopDir, 1))[0] === "Imported 5 wiki pages" && (await commits(shopDir)) === 2, (await subjects(shopDir)).join(" | "));
  const secretFile = read(shopDir, "pages/keys.md") ?? "";
  check("a key written into a page is hidden in git…", !secretFile.includes("sk-ant-") && secretFile.includes("[secret hidden]"), secretFile);
  const legacySecret = db.prepare(`SELECT content FROM wiki_pages_legacy WHERE id = ?`).get(ids.secret) as { content: string } | undefined;
  check("…and kept in the legacy table, nothing lost", legacySecret?.content.includes("sk-ant-api03") === true && wiki.get(ids.secret)?.content.includes("[secret hidden]") === true);
  check("a deleted page isn't a file, and stays (deleted) in the index and the legacy table", !read(shopDir, "pages/old-notes.md") && wiki.get(ids.gone) === null && Boolean(db.prepare(`SELECT 1 FROM wiki_pages WHERE id = ? AND deleted_at IS NOT NULL`).get(ids.gone)) && Boolean(db.prepare(`SELECT 1 FROM wiki_pages_legacy WHERE id = ?`).get(ids.gone)));
  const web = wiki.get(ids.web)!;
  check("ids, places and authors are kept", web.updatedBy === "keeper" && web.conversationId === "chat-before" && web.updatedAt === day + 6 && web.createdAt === day + 1 && wiki.get(ids.architecture)?.parentId === ids.web && wiki.overview(ids.shopBrain).id === ids.overview);
  check("the index knows each page's file", (db.prepare(`SELECT path FROM wiki_pages WHERE id = ?`).get(ids.web) as { path: string }).path === "pages/web.md");
  const legacyRevs = wiki.revisions(ids.web);
  check("old revisions are readable as “Before git”", legacyRevs.length === 2 && legacyRevs.every((r) => r.legacy) && legacyRevs[0]!.content === "Next.js storefront, second draft.", JSON.stringify(legacyRevs.map((r) => r.content)));
  check("…and kept in wiki_revisions_legacy", (db.prepare(`SELECT COUNT(*) AS n FROM wiki_revisions_legacy WHERE page_id = ?`).get(ids.web) as { n: number }).n === 2);
  check("FTS still finds pages", wiki.search(ids.shopBrain, "storefront")[0]?.id === ids.web && wiki.relevant(ids.shopBrain, "how do the pages call the api client", 3).some((p) => p.id === ids.architecture));

  console.log("\n# Memory's facts ignore the wiki's pages");
  await remember({ repo: "projects/shop", text: "Tests need TZ=UTC", source: "you", actor: "you" });
  const facts = memories.list("projects/shop");
  check("the web page's bullet lines aren't facts", facts.length === 1 && facts[0]!.content === "Tests need TZ=UTC", JSON.stringify(facts.map((f) => f.content)));
  check("memory's files list leaves pages/ out", repoFiles("projects/shop").every((f) => !f.path.startsWith("pages/")) && repo.listFiles("projects/shop", { documents: true }).some((f) => f.startsWith("pages/")));
  const intoPages = await remember({ repo: "projects/shop", text: "A fact", file: "pages/facts", source: "you", actor: "you" }).then(
    () => "",
    (err: Error) => err.message,
  );
  check("a fact can't be written into pages/", /where the wiki's pages live/.test(intoPages), intoPages);

  console.log("\n# A move that failed is tried again");
  const status = await api("GET", `/projects/${ids.broken}/knowledge`);
  check("the status says the wiki still works from the database, with the error", status.status === 200 && status.data.state === "database" && Boolean(status.data.error) && status.data.pages === 2, status.text);
  const dbPage = wiki.create(ids.brokenBrain, { title: "Meanwhile", summary: "Written while it couldn't move", content: "Still works." }, "user");
  wiki.update(ids.brokenPage, { content: "Ship the thing, then rest." }, "agent");
  check("…and it does: writes go to the database, with revisions as before", wiki.get(dbPage.id)?.content === "Still works." && wiki.revisions(ids.brokenPage).length === 1 && !wiki.revisions(ids.brokenPage)[0]!.legacy);
  unlinkSync(brokenRepoDir);
  const second = await store.startStore();
  check("the next start moves it", second.moved === 1 && knowledge.mode(ids.brokenBrain) === "git" && (await api("GET", `/projects/${ids.broken}/knowledge`)).data.state === "git", JSON.stringify(second));
  check("…with what was written meanwhile, and its revision kept as “Before git”", read(repo.repoDir("projects/broken"), "pages/meanwhile.md")?.includes("Still works.") === true && wiki.revisions(ids.brokenPage)[0]?.legacy === true && wiki.revisions(ids.brokenPage)[0]?.content === "Ship the thing.");
  const third = await store.startStore();
  check("starting again changes nothing", third.moved === 0 && third.failed.length === 0 && (await commits(shopDir)) === 3);

  // --- Every wiki.* call on git ---------------------------------------------------------------------------------
  console.log("\n# The wiki API on git");
  const chatA = conversations.create({ agentId: ids.agent, modelId: "auto" });
  const chatB = conversations.create({ agentId: ids.agent, modelId: "auto" });
  const before = await commits(shopDir);
  const checkout = wiki.create(ids.shopBrain, { title: "Checkout", summary: "How checkout works", content: "Totals in `src/checkout/total.ts`.", parentId: ids.web }, "agent", chatA.id);
  check("create: the index has it at once, with a change waiting", wiki.get(checkout.id)?.parentId === ids.web && store.pendingChanges(ids.shopBrain).length === 1);
  await knowledge.flush(ids.shopBrain);
  const checkoutFile = read(shopDir, "pages/checkout.md") ?? "";
  check("…then a file and one commit by the agent", checkoutFile.includes(`parent: ${ids.web}`) && (await commits(shopDir)) === before + 1 && (await subjects(shopDir, 1))[0] === "Kiwi: write page “Checkout”" && store.pendingChanges(ids.shopBrain).length === 0, checkoutFile);
  const trailer = await g(shopDir, "log", "-1", "--format=%B");
  check("the commit says who, from which chat, and which page", trailer.includes("TOT-Author: agent") && trailer.includes(`TOT-Chat: ${chatA.id}`) && trailer.includes(`TOT-Page: ${checkout.id} create`), trailer);
  wiki.update(checkout.id, { content: "Totals in `src/checkout/total.ts`; gift cards apply first." }, "agent", chatA.id);
  wiki.update(checkout.id, { content: "Totals in `src/checkout/total.ts`; gift cards apply before tax." }, "agent", chatA.id);
  const pendingRevs = wiki.revisions(checkout.id);
  check("one revision per editing burst (as before git), even before the commits land", pendingRevs.length === 1 && pendingRevs[0]!.content === "Totals in `src/checkout/total.ts`." && !pendingRevs[0]!.legacy, JSON.stringify(pendingRevs));
  await knowledge.flush(ids.shopBrain);
  const landedRevs = wiki.revisions(checkout.id);
  check("…and the same revision (same id) once they have", landedRevs.length === 1 && landedRevs[0]!.id === pendingRevs[0]!.id && (await commits(shopDir)) === before + 3);
  wiki.update(checkout.id, { content: "Rewritten by the user." }, "user");
  check("another author starts a new revision", wiki.revisions(checkout.id).length === 2 && wiki.revisions(checkout.id)[0]!.updatedBy === "agent");
  const restored = wiki.restore(checkout.id, wiki.revisions(checkout.id)[0]!.id, "user");
  check("restore brings the old text back, and the restore can itself be undone", restored.content.includes("before tax") && wiki.revisions(checkout.id)[0]?.content === "Rewritten by the user.");
  await knowledge.flush(ids.shopBrain);
  check("…as a new commit", (await subjects(shopDir, 1))[0] === "you: restore page “Checkout”" && (read(shopDir, "pages/checkout.md") ?? "").includes("before tax"));
  check("a restore by an unknown id is refused", (() => {
    try {
      wiki.restore(checkout.id, "no-such-version", "user");
      return false;
    } catch (err) {
      return err instanceof WikiError;
    }
  })());

  wiki.update(ids.deploys, { position: 9 }, "user");
  const reordered = wiki.get(ids.deploys)!;
  wiki.update(ids.deploys, { title: "Run & ship" }, "agent", chatB.id);
  await knowledge.flush(ids.shopBrain);
  const deploysNow = read(shopDir, "pages/run-test-deploy.md") ?? "";
  check("a reorder keeps who wrote the page", reordered.updatedBy === "agent" && reordered.updatedAt === day + 3 && reordered.position === 9);
  check("a rename keeps its file", deploysNow.includes('title: "Run & ship"') && deploysNow.includes("position: 9") && !wiki.revisions(ids.deploys).some((r) => r.title === "Run, test & deploy" && r.content !== "Deploy with `make ship`."), deploysNow);

  const guide = wiki.create(ids.shopBrain, { title: "Guides", summary: "How-tos", content: "Start here." }, "user");
  const childOne = wiki.create(ids.shopBrain, { title: "web", summary: "A guide with a clashing title", content: "x", parentId: guide.id }, "user");
  wiki.delete(guide.id, "agent", chatB.id);
  await knowledge.flush(ids.shopBrain);
  check("delete: the file goes, the page is kept (deleted) and its children move up, renamed", !read(shopDir, "pages/guides.md") && wiki.get(guide.id) === null && Boolean(db.prepare(`SELECT 1 FROM wiki_pages WHERE id = ?`).get(guide.id)) && wiki.get(childOne.id)?.title === "web (Guides)" && wiki.get(childOne.id)?.parentId === null && (read(shopDir, "pages/web-2.md") ?? "").includes("title: web (Guides)") && (await subjects(shopDir, 1))[0] === "Kiwi: delete page “Guides”", (await subjects(shopDir, 1))[0]);
  check("count, list, outline, find, withTitle", wiki.count(ids.shopBrain) === 7 && wiki.list(ids.shopBrain)[0]!.id === ids.overview && wiki.outline(ids.shopBrain).find((p) => p.id === checkout.id)?.depth === 1 && wiki.find(ids.shopBrain, ids.web)?.id === ids.web && wiki.withTitle(ids.shopBrain, "checkout").length === 1, String(wiki.count(ids.shopBrain)));
  check("find by an ambiguous title asks for the id", (() => {
    wiki.create(ids.shopBrain, { title: "Architecture", summary: "Top-level", content: "y" }, "user");
    try {
      wiki.find(ids.shopBrain, "Architecture");
      return false;
    } catch (err) {
      return err instanceof WikiError && /Several pages/.test(err.message);
    }
  })());
  const overviewEdit = wiki.update(ids.overview, { content: "The shop: a storefront, its API and a mobile app." }, "user");
  await knowledge.flush(ids.shopBrain);
  check("the Overview's edits land in pages/overview.md", (read(shopDir, "pages/overview.md") ?? "").includes("mobile app") && overviewEdit.pinned);

  console.log("\n# Secrets are refused");
  const refusals = [
    () => wiki.create(ids.shopBrain, { title: "Tokens", summary: "x", content: "The key is sk-ant-api03-zyxwvutsrqponmlkjihgfedcba9876" }, "agent"),
    () => wiki.update(ids.web, { content: `${wiki.get(ids.web)!.content}\nThe staging password is Hunter2!xyz` }, "agent"),
    () => wiki.update(ids.web, { summary: "xoxb-1234567890-abcdefghijkl" }, "user"),
  ].map((fn) => {
    try {
      fn();
      return "";
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  });
  check("a key, a password and a token are refused", refusals.every((r) => r === WIKI_SECRET_REFUSAL) && !wiki.withTitle(ids.shopBrain, "Tokens").length && !wiki.get(ids.web)!.content.includes("Hunter2"), refusals.join(" | "));
  const routeRefusal = await api("POST", `/brains/${ids.shopBrain}/wiki`, { title: "Keys 2", summary: "x", content: "AKIAABCDEFGHIJKLMNOP" });
  check("…over the API too (400)", routeRefusal.status === 400 && routeRefusal.data.error === WIKI_SECRET_REFUSAL, routeRefusal.text);
  const hidden = wiki.get(ids.secret)!;
  wiki.update(ids.secret, { content: `${hidden.content}\nRotate it monthly.` }, "agent");
  check("a password line already on the page doesn't lock it", hidden.content.includes("Sunflower99!") && wiki.get(ids.secret)!.content.endsWith("Rotate it monthly."));

  // --- Hand edits and the index ---------------------------------------------------------------------------------
  console.log("\n# The index is rebuilt from the files");
  const ops = wiki.create(ids.shopBrain, { title: "Ops", summary: "Operations", content: "On call." }, "user");
  const runbook = wiki.create(ids.shopBrain, { title: "Runbook", summary: "What to do when it breaks", content: "Restart it.", parentId: ops.id }, "user");
  await knowledge.flush(ids.shopBrain);
  rmSync(join(shopDir, "pages/ops.md"));
  const webFile = read(shopDir, "pages/web.md")!;
  writeFileSync(join(shopDir, "pages/web.md"), webFile.replace("Next.js storefront.", "Next.js 16 storefront, edited by hand."));
  writeFileSync(join(shopDir, "pages/ideas.md"), "# Ideas\n\nA page someone wrote without front matter.\n");
  rmSync(join(shopDir, "pages/architecture.md"));
  // Memory's next change commits hand edits first; the wiki reads its pages again after it.
  await remember({ repo: "projects/shop", text: "Deploys need VPN", source: "you", actor: "you" });
  const ideas = wiki.withTitle(ids.shopBrain, "Ideas")[0];
  check("a hand edit is read back, as the user's", wiki.get(ids.web)?.content.includes("edited by hand") === true && wiki.get(ids.web)?.updatedBy === "user");
  check("a file someone made becomes a page (title from its heading)", Boolean(ideas) && ideas!.content === "A page someone wrote without front matter." && ideas!.parentId === null);
  check("a file someone removed: the page is marked deleted, kept", wiki.get(ids.architecture) === null && Boolean(db.prepare(`SELECT 1 FROM wiki_pages WHERE id = ? AND deleted_at IS NOT NULL`).get(ids.architecture)));
  check("…and its history says so", (await subjects(shopDir, 2)).includes("Edited outside TOT"));
  check("a page whose parent's file went sits at the top, and stays there", wiki.get(ops.id) === null && wiki.get(runbook.id)?.parentId === null && wiki.list(ids.shopBrain).some((p) => p.id === runbook.id) && store.reconcile(ids.shopBrain) === 0);
  const webRevs = wiki.revisions(ids.web);
  check("history counts edits made outside TOT", webRevs[0]?.content.startsWith("Next.js storefront.") === true && !webRevs[0]!.legacy && webRevs.some((r) => r.legacy), JSON.stringify(webRevs.map((r) => r.content.slice(0, 30))));

  // --- History and undo through the knowledge routes ------------------------------------------------------------
  console.log("\n# One history for facts and pages, with undo");
  wiki.update(checkout.id, { content: "Totals; gift cards; refunds go back to the card." }, "agent", chatA.id);
  await knowledge.flush(ids.shopBrain);
  const history = await api("GET", `/projects/${ids.shop}/knowledge/history?limit=30`);
  const pageCommit = history.data?.[0];
  check("history lists page commits with their pages, and facts", history.status === 200 && pageCommit?.pages?.[0]?.id === checkout.id && pageCommit.pages[0].action === "edited" && history.data.some((c: { subject: string; pages: unknown[] }) => c.subject === "you: remember “Tests need TZ=UTC”" && c.pages.length === 0), history.text.slice(0, 300));
  const importCommit = history.data.find((c: { kind: string; pages: unknown[] }) => c.kind === "import" && c.pages.length === 5);
  check("…and the import, with its pages, not offered for undo", Boolean(importCommit) && importCommit.revertible === false);
  const undoImport = await api("POST", `/projects/${ids.shop}/knowledge/undo`, { sha: importCommit?.sha ?? "0000000" });
  check("…and undoing the move into git is refused (400), nothing changes", undoImport.status === 400 && /can't be undone/.test(undoImport.data?.error ?? "") && wiki.count(ids.shopBrain) > 5, undoImport.text);
  const undone = await api("POST", `/projects/${ids.shop}/knowledge/undo`, { sha: pageCommit.sha });
  check("undo of a page edit puts the page back (a new commit)", undone.status === 200 && undone.data.kind === "undo" && wiki.get(checkout.id)?.content.includes("before tax") === true, undone.text.slice(0, 200));
  const status2 = await api("GET", `/projects/${ids.shop}/knowledge`);
  check("GET /api/projects/:id/knowledge", status2.status === 200 && status2.data.state === "git" && status2.data.repo === "projects/shop" && status2.data.path.endsWith("memory/projects/shop") && status2.data.facts === 2 && status2.data.pages === wiki.count(ids.shopBrain), status2.text);

  // --- A repo's docs --------------------------------------------------------------------------------------------
  console.log("\n# A project repo's docs");
  const apiPage = wiki.create(ids.shopBrain, { title: "api", summary: "The backend", content: "Hono API." }, "agent");
  const apiChild = wiki.create(ids.shopBrain, { title: "Routes", summary: "Where routes live", content: "src/routes.ts", parentId: apiPage.id }, "agent");
  const apiHead = knowledge.repoHead(ids.shopBrain, "api");
  await knowledge.flush(ids.shopBrain);
  check("a top-level page titled after the repo becomes its head", apiHead.id === apiPage.id && apiHead.repo === "api" && read(shopDir, "repos/api/README.md")?.includes("repo: api") === true && !read(shopDir, "pages/api.md"));
  check("…and its subtree moves into repos/<name>/", read(shopDir, "repos/api/routes.md")?.includes(`parent: ${apiPage.id}`) === true && !read(shopDir, "pages/routes.md") && wiki.get(apiChild.id)?.parentId === apiPage.id);
  const mobile = knowledge.repoHead(ids.shopBrain, "mobile");
  const screen = wiki.create(ids.shopBrain, { title: "Screens", summary: "The app's screens", content: "Expo router.", parentId: mobile.id }, "agent");
  await knowledge.flush(ids.shopBrain);
  check("a missing head is made; pages under it go to repos/<name>/", mobile.repo === "mobile" && mobile.parentId === null && read(shopDir, "repos/mobile/README.md") !== null && read(shopDir, "repos/mobile/screens.md")?.includes("Expo router.") === true);
  const mobileCommit = (await knowledge.history(projects.get(ids.shop)!, 3)).find((c) => c.pages.some((p) => p.id === mobile.id));
  check("history says the head page was created", mobileCommit?.pages.find((p) => p.id === mobile.id)?.action === "created" && mobileCommit.subject === "TOT: start the docs of mobile", JSON.stringify(mobileCommit?.pages));
  check("repoHead finds it again; repoPages lists its docs", knowledge.repoHead(ids.shopBrain, "Mobile").id === mobile.id && knowledge.repoPages(ids.shopBrain, "mobile").map((p) => p.id).join() === [mobile.id, screen.id].join());
  check("WikiPageSummary.repo marks heads", wiki.list(ids.shopBrain).filter((p) => p.repo).map((p) => p.repo).sort().join() === "api,mobile");
  knowledge.renameRepo(ids.shopBrain, "mobile", "app");
  await knowledge.flush(ids.shopBrain);
  check(
    "a repo renamed: its head page follows, and its docs move to repos/<new>/ in one commit",
    wiki.get(mobile.id)?.repo === "app" &&
      read(shopDir, "repos/app/README.md")?.includes("repo: app") === true &&
      read(shopDir, "repos/app/screens.md")?.includes("Expo router.") === true &&
      !read(shopDir, "repos/mobile/README.md") &&
      (await subjects(shopDir, 1))[0] === "TOT: the docs of mobile are now app's",
    (await subjects(shopDir, 1))[0],
  );
  knowledge.renameRepo(ids.shopBrain, "app", "mobile");
  await knowledge.flush(ids.shopBrain);

  console.log("\n# Learn a repo for a project repo writes under its head page");
  const turnsBefore = turns.length;
  const learned = await learnRepo(ids.agent, "https://github.com/acme/web", { projectId: ids.shop, repoName: "web" });
  for (let i = 0; i < 100 && turns.length < turnsBefore + 2; i++) await sleep(50);
  const webHead = knowledge.repoHead(ids.shopBrain, "web");
  const survey = turns[turnsBefore];
  const preamble = JSON.stringify(survey ?? {});
  check("it studies into the project's brain, under the repo's head page", learned.brainId === ids.shopBrain && webHead.id === ids.web && preamble.includes(`parent: \\"${ids.web}\\"`), preamble.slice(0, 200));
  check("…without a brain of its own, and the chat is the project's", brains.list().length === 3 && conversations.get(learned.conversationId)?.projectId === ids.shop && conversations.get(learned.conversationId)?.title === "Learn web");
  const missing = turns[turnsBefore + 1];
  check("the study plan is looked for under the head", JSON.stringify(missing ?? {}).includes(`parent \\"${ids.web}\\"`), JSON.stringify(missing ?? {}).slice(0, 200));

  // --- One commit per batch ------------------------------------------------------------------------------------
  console.log("\n# Batches and the commit of a write");
  await knowledge.flush(ids.shopBrain);
  const n = await commits(shopDir);
  const { sha } = await knowledge.batch(ids.shopBrain, { subject: "Knowledge: after “Fix cart”", actor: "TOT" }, () => {
    wiki.update(checkout.id, { content: "Totals, gift cards, refunds, and the cart fix." }, "agent");
    wiki.create(ids.shopBrain, { title: "Cart", summary: "The cart", content: "Cart lives in `src/cart`.", parentId: ids.web }, "agent");
  });
  const headSha = (await g(shopDir, "rev-parse", "HEAD")).trim();
  check("a batch is one commit, and says which", (await commits(shopDir)) === n + 1 && sha === headSha && (await subjects(shopDir, 1))[0] === "Knowledge: after “Fix cart”");

  // --- A brain that joins a project brings its pages -------------------------------------------------------------
  console.log("\n# A brain made before its project");
  const docs = brains.create({ name: "Docs site", kind: "notes" });
  wiki.create(docs.id, { title: "Style guide", summary: "How the docs read", content: "Short sentences." }, "user");
  await knowledge.flush(docs.id);
  const ownRepo = repo.repoDir(`brains/${docs.id}`);
  check("a brain of its own starts in its own repo", read(ownRepo, "pages/style-guide.md") !== null && knowledge.mode(docs.id) === "git");
  const docsProject = projects.create({ kind: "none", name: "Docs site" });
  check("the project takes that brain", docsProject.brainId === docs.id);
  const style = wiki.withTitle(docs.id, "Style guide")[0]!;
  wiki.update(style.id, { content: "Short sentences. No jargon." }, "user");
  for (let i = 0; i < 100 && knowledge.repoFor(docs.id) !== `projects/${docsProject.slug}`; i++) await sleep(50);
  await knowledge.flush(docs.id);
  const docsDir = repo.repoDir(`projects/${docsProject.slug}`);
  check("its pages follow it into the project's repo, ids kept", read(docsDir, "pages/style-guide.md")?.includes(`id: ${style.id}`) === true && (read(docsDir, "pages/style-guide.md") ?? "").includes("No jargon.") && (await subjects(docsDir, 3)).some((s) => s.startsWith("Moved")), (await subjects(docsDir, 3)).join(" | "));
  check("…and their history from the old repo still counts", wiki.revisions(style.id)[0]?.content === "Short sentences.");

  // --- Crash safety and parallel writers ------------------------------------------------------------------------
  console.log("\n# A change left waiting by a crash lands at the next start");
  // As a crash leaves it: the index ahead, the change recorded, nothing written yet.
  await knowledge.flush(ids.shopBrain);
  db.prepare(`UPDATE wiki_pages SET content = ? WHERE id = ?`).run("Written just before a crash.", ids.overview);
  const waiting = wiki.get(ids.overview)!;
  db.prepare(
    `INSERT INTO wiki_changes (id, brain_id, files, pages, subject, actor, kind, author, conversation_id, batch, created_at) VALUES (?, ?, ?, ?, 'you: edit page “Overview”', 'you', 'edit', 'user', NULL, NULL, ?)`,
  ).run(
    randomUUID(),
    ids.shopBrain,
    JSON.stringify({ "pages/overview.md": renderPage({ ...waiting, repo: null }) }),
    JSON.stringify([{ id: ids.overview, op: "edit", path: "pages/overview.md" }]),
    Date.now(),
  );
  check("a change waiting from before the crash doesn't lose the index's text", store.reconcile(ids.shopBrain) === 0 && wiki.get(ids.overview)?.content === "Written just before a crash.");
  await store.startStore();
  check("it's committed at the next start", (read(shopDir, "pages/overview.md") ?? "").includes("Written just before a crash.") && store.pendingChanges(ids.shopBrain).length === 0 && wiki.get(ids.overview)?.content === waiting.content && (await subjects(shopDir, 1))[0] === "you: edit page “Overview”");

  console.log("\n# 20 writers beside memory, in one repo");
  const m = await commits(shopDir);
  const chats = Array.from({ length: 20 }, () => conversations.create({ agentId: ids.agent, modelId: "auto" }));
  const writes = chats.map((c, i) => Promise.resolve().then(() => wiki.create(ids.shopBrain, { title: `Note ${i}`, summary: `Parallel note ${i}`, content: `Written by chat ${i}.` }, "agent", c.id)));
  const saves = Array.from({ length: 5 }, (_, i) => remember({ repo: "projects/shop", text: `Parallel fact ${i}`, source: "you", actor: "you" }));
  await Promise.all([...writes, ...saves]);
  await knowledge.flush(ids.shopBrain);
  const clean = !(await g(shopDir, "status", "--porcelain")).trim();
  check("25 commits, nothing lost, nothing left over", (await commits(shopDir)) === m + 25 && clean && Array.from({ length: 20 }, (_, i) => read(shopDir, `pages/note-${i}.md`)).every(Boolean) && memories.list("projects/shop").filter((f) => f.content.startsWith("Parallel fact")).length === 5, String((await commits(shopDir)) - m));
  check("the index matches the files", store.reconcile(ids.shopBrain) === 0);

  console.log("\n# The wiki's routes work unchanged on git");
  const created = await api("POST", `/brains/${ids.shopBrain}/wiki`, { title: "From the UI", summary: "Made in the wiki view", content: "Hello." });
  const patched = await api("PATCH", `/wiki/${created.data.id}`, { content: "Hello again." });
  const revs = await api("GET", `/wiki/${created.data.id}/revisions`);
  const back = await api("POST", `/wiki/${created.data.id}/revisions/${revs.data[0]?.id}/restore`, {});
  const removed = await api("DELETE", `/wiki/${created.data.id}`);
  await knowledge.flush(ids.shopBrain);
  check("create, edit, history, restore, delete", created.status === 201 && patched.data.content === "Hello again." && revs.data.length === 1 && back.data.content === "Hello." && removed.status === 200 && !read(shopDir, "pages/from-the-ui.md"), `${created.status} ${revs.text.slice(0, 120)}`);
} catch (err) {
  failures++;
  console.log(`FAIL  threw — ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
} finally {
  server.close();
}

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
