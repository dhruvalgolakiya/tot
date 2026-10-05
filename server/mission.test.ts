// Mission control (roadmap module 09, lane B): diff stats after every turn, the board's overlaps and land order,
// starting tasks from the composer, and best-of runs. Fake model turns and fixture provider statuses, real git on the
// local computer. Run: TOT_DATA_DIR=$(mktemp -d) npx tsx server/mission.test.ts
import "./test-data-dir.ts"; // first: refuses to run against the real ~/.tot
import { randomUUID } from "node:crypto";
import { serve } from "@hono/node-server";
import type { Conversation, Message, MissionOverview, ModelOption, ProviderStatus, SendMessageRequest, TaskDiffStats } from "../shared/types.ts";

process.env.TOT_ACCESS_TOKEN = ""; // empty overrides .env: no sign-in for this test
const PORT = 8798;

const { HttpError } = await import("./agent/orchestrator.ts");
const { MessageBuilder } = await import("./agent/message-builder.ts");
const { runRegistry } = await import("./agent/runs.ts");
const { computerManager } = await import("./computer/manager.ts");
const { agents } = await import("./data/agents.ts");
const { conversations, toPublicConversation } = await import("./data/conversations.ts");
const { messages } = await import("./data/messages.ts");
const { settings } = await import("./data/settings.ts");
const { createApp } = await import("./app.ts");
const { missionWatch } = await import("./mission/watch.ts");
const { spawnMany } = await import("./orchestration/spawn.ts");
const { statuses } = await import("./orchestration/statuses.ts");
const { runLoop } = await import("./tasks/run-loop.ts");
const { taskQueue } = await import("./tasks/queue.ts");
const { taskStore } = await import("./tasks/store.ts");
const { tasks } = await import("./tasks/tasks.ts");
const { chatWakes } = await import("./tasks/wake.ts");
type TurnOptions = import("./agent/orchestrator.ts").TurnOptions;

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail.replace(/\n/g, " ⏎ ").slice(0, 260)}` : ""}`);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(condition: () => boolean, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end && !condition(); ) await sleep(20);
}
const status = (id: string) => taskStore.get(id)?.task.status;
const mascot = { shape: "blob" as const, color: "#60a5fa", accessory: "none" as const, eyes: "dots" as const };

settings.patch({
  computer: { mode: "local" },
  tasks: { perAgentLimit: 8, globalLimit: 12, maxChildren: 6, missionTokenBudget: 0, wakeChats: true, switchProviders: true },
});

// --- Fixture providers: both signed in -----------------------------------------
const option = (provider: "claude" | "chatgpt", model: string): ModelOption => ({ id: `${provider}:${model}`, provider, model, label: model, available: true });
const CLAUDE: ProviderStatus = { id: "claude", label: "Claude", installed: true, loggedIn: true, models: [option("claude", "claude-opus-5-5"), option("claude", "claude-sonnet-5-5")] };
const CHATGPT: ProviderStatus = { id: "chatgpt", label: "ChatGPT", installed: true, loggedIn: true, models: [option("chatgpt", "gpt-6.1-sol"), option("chatgpt", "gpt-6-luna")] };
let fixture: ProviderStatus[] = [CLAUDE, CHATGPT];
statuses.use(async () => fixture);

// --- Fake model turns: each task (or chat) can have a script --------------------
interface Turn {
  id: string;
  index: number;
  tool: (name: string) => void;
}
type Script = (turn: Turn) => Promise<void>;
const scripts = new Map<string, Script>();
const byGoal: [RegExp, Script][] = [];
const sent: { conversationId: string; text: string; auto: boolean }[] = [];
const sentTo = (id: string) => sent.filter((s) => s.conversationId === id);

async function fakeSend(conversationId: string, request: SendMessageRequest, options: TurnOptions = {}) {
  if (runRegistry.activeFor(conversationId)) throw new HttpError(409, "Busy.");
  const index = sentTo(conversationId).length;
  sent.push({ conversationId, text: request.text, auto: Boolean(options.auto) });
  const now = Date.now();
  const user: Message = { id: randomUUID(), conversationId, role: "user", parts: [{ type: "text", id: randomUUID(), text: request.text }], status: "complete", createdAt: now };
  messages.insert(user);
  const assistant: Message = { id: randomUUID(), conversationId, role: "assistant", parts: [], status: "streaming", createdAt: now + 1 };
  messages.insert(assistant);
  const run = runRegistry.create(conversationId, assistant.id);
  const builder = new MessageBuilder(assistant, (event) => run.push(event));
  run.reply = () => builder.message;
  void (async () => {
    await sleep(5);
    const goal = conversations.get(conversationId)?.task?.goal ?? "";
    const script = scripts.get(conversationId) ?? byGoal.find(([pattern]) => pattern.test(goal))?.[1];
    const turn: Turn = {
      id: conversationId,
      index,
      tool: (name) => {
        const id = randomUUID();
        builder.apply({ type: "tool-start", toolCallId: id, name, input: {} });
        builder.apply({ type: "tool-end", toolCallId: id, output: "ok" });
      },
    };
    try {
      if (script) await script(turn);
      else builder.apply({ type: "text-delta", blockId: randomUUID(), delta: "ok" });
    } catch (err) {
      console.error("script failed:", err);
    }
    const final = builder.finish(run.controller.signal.aborted ? "stopped" : "complete");
    messages.save(final);
    run.push({ type: "run-end", status: final.status as "complete", message: final });
    runRegistry.finish(run);
  })();
  return { runId: run.id, userMessage: user, conversation: toPublicConversation(conversations.get(conversationId)!) };
}
runLoop.useSender(fakeSend);

tasks.start();
chatWakes.start();
chatWakes.useBatchDelay(100);
missionWatch.start();

const server = serve({ fetch: createApp().fetch, port: PORT, hostname: "127.0.0.1" });
async function request<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`http://127.0.0.1:${PORT}/api${path}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

// --- A repo on the coder's computer ------------------------------------------------
const coder = agents.create({ name: "Coder", mascot });
const computer = await computerManager.ensure(coder.id);
const sh = async (command: string, cwd?: string) => {
  const result = await computer.backend.exec(computer.externalId, command, { cwd, timeoutMs: 60_000 });
  if (result.exitCode !== 0) throw new Error(`${command}: ${result.stderr}`);
  return result.stdout.trim();
};
const GIT = "git -c user.email=t@example.com -c user.name=T";
await sh(
  `git init -q -b main repos/demo && cd repos/demo && printf 'one\\n' > README.md && printf 'x\\ny\\n' > old.txt && printf 's1\\ns2\\n' > shared.txt && git add . && ${GIT} commit -qm init`,
);
const worktreeOf = (id: string) => taskStore.get(id)!.task.repo!.worktree.replace(/^~\//, "");
const coding = (goal: string) => tasks.create({ agentId: coder.id, goal, repo: "~/repos/demo" });
const statsOf = (id: string) => taskStore.get(id)?.task.stats ?? null;

// =============================================================================
// Stats after every turn
// =============================================================================
let afterFirstTurn: TaskDiffStats | null = null;
const statsTask = coding("Touch the readme");
scripts.set(statsTask.id, async (t) => {
  const cwd = worktreeOf(t.id);
  if (t.index === 0) {
    // Committed (+1 line), and a new untracked file (3 lines).
    await sh(`printf 'two\\n' >> README.md && git add README.md && ${GIT} commit -qm readme && printf 'a\\nb\\nc\\n' > notes.txt`, cwd);
    t.tool("computer_exec");
    return;
  }
  afterFirstTurn = statsOf(t.id);
  // Uncommitted: a deleted file (−2) and one more line in the untracked file.
  await sh(`git rm -q old.txt && printf 'd\\n' >> notes.txt`, cwd);
  tasks.finish(t.id, "done", "Touched the readme.");
});
await until(() => status(statsTask.id) === "done", 20_000);
await until(() => statsOf(statsTask.id)?.files === 3);
const first = afterFirstTurn as TaskDiffStats | null;
check(
  "stats recorded after a turn (committed and untracked)",
  first !== null && first.files === 2 && first.added === 4 && first.removed === 0 && [...first.paths].sort().join(",") === "README.md,notes.txt",
  JSON.stringify(first),
);
let stats = statsOf(statsTask.id);
check(
  "…and refreshed by the last turn (uncommitted deletion counted)",
  stats !== null && stats.files === 3 && stats.added === 5 && stats.removed === 2 && [...stats.paths].sort().join(",") === "README.md,notes.txt,old.txt",
  JSON.stringify(stats),
);
check("…with the branch head", stats?.headSha === taskStore.get(statsTask.id)!.task.repo!.headSha && Boolean(stats?.headSha), JSON.stringify(stats));

// Stopped between turns: the finish refreshes them too.
const stopped = coding("Stop me midway");
let wroteMidway = false;
scripts.set(stopped.id, async (t) => {
  const signal = runRegistry.activeFor(t.id)!.controller.signal;
  await sh(`printf 'n\\n' > midway.txt`, worktreeOf(t.id));
  wroteMidway = true;
  // Stays in its turn until the user stops it.
  if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
});
await until(() => wroteMidway, 20_000);
check("no stats before its first turn ends", statsOf(stopped.id) === null, JSON.stringify(statsOf(stopped.id)));
await request("POST", `/tasks/${stopped.id}/stop`);
await until(() => statsOf(stopped.id)?.paths.includes("midway.txt") === true);
check("stats refreshed when a task is stopped", statsOf(stopped.id)?.files === 1 && statsOf(stopped.id)?.added === 1, JSON.stringify(statsOf(stopped.id)));

// =============================================================================
// Overlaps and land order
// =============================================================================
const edit = (commands: string, finish = true): Script => async (t) => {
  await sh(commands, worktreeOf(t.id));
  t.tool("computer_exec");
  if (finish) tasks.finish(t.id, "done", "Done.");
  else tasks.update(t.id, { question: "Which color?" });
};
const small = coding("Add c2");
scripts.set(small.id, edit(`printf '1\\n' > c2.txt`));
const big = coding("Add d");
scripts.set(big.id, edit(`printf '1\\n2\\n3\\n4\\n5\\n' > d.txt`));
const wide = coding("Change shared and a");
scripts.set(wide.id, edit(`printf 's3\\n' >> shared.txt && printf '1\\n2\\n3\\n' > a.txt && git add . && ${GIT} commit -qm wide`));
const narrow = coding("Change shared");
scripts.set(narrow.id, edit(`printf 's4\\n' >> shared.txt && printf '1\\n' > b.txt`));
const asking = coding("Also a");
scripts.set(asking.id, edit(`printf 'z\\n' > a.txt`, false));
await until(() => [small, big, wide, narrow].every((t) => status(t.id) === "done") && status(asking.id) === "needs-input", 30_000);
await until(() => [small, big, wide, narrow, asking].every((t) => statsOf(t.id) !== null));

let board = (await request<MissionOverview>("GET", `/mission?agentId=${coder.id}`)).data;
const onBoard = (id: string) => board.tasks.find((t) => t.conversation.id === id);
const overlapIds = (id: string) =>
  (onBoard(id)?.overlaps ?? [])
    .map((o) => `${o.taskId === wide.id ? "wide" : o.taskId === narrow.id ? "narrow" : o.taskId === asking.id ? "asking" : o.taskId}:${o.paths.join("+")}`)
    .sort()
    .join(",");
check("overlap: same file on two branches", overlapIds(narrow.id) === "wide:shared.txt", overlapIds(narrow.id));
check("overlap: an open task counts too", overlapIds(wide.id) === "asking:a.txt,narrow:shared.txt" && overlapIds(asking.id) === "wide:a.txt", `${overlapIds(wide.id)} | ${overlapIds(asking.id)}`);
check("no overlap for separate files", onBoard(small.id)?.overlaps.length === 0 && onBoard(big.id)?.overlaps.length === 0);
const order = board.landOrder.filter((id) => [small.id, big.id, wide.id, narrow.id, statsTask.id, asking.id].includes(id));
const named = (id: string) => ({ [small.id]: "small", [big.id]: "big", [wide.id]: "wide", [narrow.id]: "narrow", [statsTask.id]: "stats", [asking.id]: "asking" })[id];
check("land order: fewest overlaps, then smallest", order.map(named).join(",") === "small,big,stats,narrow,wide", order.map(named).join(","));
check("open tasks aren't in the land order", !board.landOrder.includes(asking.id) && Boolean(onBoard(asking.id)));
check("stopped tasks with code can land", board.landOrder.includes(stopped.id));

// A best-of run's alternatives don't overlap each other (only one of them lands).
const { findOverlaps } = await import("./mission/overview.ts");
const record = (id: string, group: string | null, groupKind: "best-of" | "parallel" | null) =>
  ({ id, task: { repo: { folder: "~/repos/x" }, landing: null, stats: { paths: ["x.ts"] }, group, groupKind } }) as unknown as Parameters<typeof findOverlaps>[0][number];
const alternatives = findOverlaps([record("one", "g", "best-of"), record("two", "g", "best-of"), record("other", null, null), record("split", "p", "parallel"), record("split2", "p", "parallel")]);
check(
  "best-of alternatives don't overlap each other",
  alternatives.get("one")?.map((o) => o.taskId).sort().join() === "other,split,split2" && alternatives.get("other")?.length === 4 && alternatives.get("split")?.some((o) => o.taskId === "split2") === true,
  JSON.stringify([...alternatives]),
);

// Landed: on the board for a day, out of the land order and of everyone's overlaps.
taskStore.patch(narrow.id, { landing: { kind: "merged", at: Date.now(), target: "main", sha: "abc1234", pr: null } });
taskStore.patch(small.id, { landing: { kind: "discarded", at: Date.now() - 2 * 86_400_000, target: null, sha: null, pr: null } });
board = (await request<MissionOverview>("GET", `/mission?agentId=${coder.id}`)).data;
check("landed today: still shown, not in the land order", Boolean(onBoard(narrow.id)) && !board.landOrder.includes(narrow.id));
check("landed two days ago: gone", !onBoard(small.id));
check("a landed task no longer overlaps", overlapIds(wide.id) === "asking:a.txt", overlapIds(wide.id));

// Tasks without code: shown while open, and for a day after they finish.
const research = tasks.create({ agentId: coder.id, goal: "Read about carts" });
scripts.set(research.id, async (t) => void tasks.finish(t.id, "done", "Read."));
await until(() => status(research.id) === "done");
board = (await request<MissionOverview>("GET", `/mission?agentId=${coder.id}`)).data;
check("finished without code: shown for a day", Boolean(onBoard(research.id)) && !board.landOrder.includes(research.id));
taskStore.patch(research.id, { finishedAt: Date.now() - 2 * 86_400_000 });
board = (await request<MissionOverview>("GET", `/mission?agentId=${coder.id}`)).data;
check("…then gone", !onBoard(research.id));

// =============================================================================
// Starting tasks from the composer: POST /api/tasks with a project and a request id
// =============================================================================
const topic = (await request("POST", "/projects", { kind: "none", name: "Launch" })).data as { id: string };
let res = await request<any>("POST", "/tasks", { agentId: coder.id, projectId: topic.id, goal: "Draft the launch post", requestId: "composer-1" });
const fromProject = res.data as Conversation;
check("a task from a project page", res.status === 201 && fromProject.projectId === topic.id && fromProject.kind === "task", JSON.stringify(res.data));
res = await request("POST", "/tasks", { agentId: coder.id, projectId: topic.id, goal: "Draft the launch post", requestId: "composer-1" });
check("…the same request id again: the same task", res.status === 200 && res.data.id === fromProject.id, `${res.status} ${res.data?.id}`);
check("…nothing new started", conversations.tasks({ agentId: coder.id }).filter((t) => t.projectId === topic.id).length === 1);
board = (await request<MissionOverview>("GET", `/mission?projectId=${topic.id}`)).data;
check("the board filtered by project", board.tasks.length === 1 && board.tasks[0]!.conversation.id === fromProject.id, board.tasks.map((t) => t.conversation.title).join(","));

// Tasks split from one job (task_spawn_many) are a "parallel" group.
const splitter = conversations.create({ agentId: coder.id, modelId: "auto", title: "Split it" });
const split = spawnMany(splitter.id, [{ goal: "Part one" }, { goal: "Part two" }], { cards: { kind: "none" } });
check("spawned together: a parallel group", split.every((t) => t.task.groupKind === "parallel" && t.task.group === split[0]!.task.group));
board = (await request<MissionOverview>("GET", `/mission?group=${split[0]!.task.group}`)).data;
check("the board filtered by group", board.tasks.length === 2);

// =============================================================================
// Best of N
// =============================================================================
const ana = agents.create({ name: "Ana", mascot });
const chat = conversations.create({ agentId: ana.id, modelId: "auto", title: "Cart total" });
const finishOn: Record<string, () => void> = {};
byGoal.push([
  /^Fix the cart total/,
  async (t) => {
    // Each run waits for the test to let it finish.
    await new Promise<void>((resolve) => (finishOn[t.id] = resolve));
    tasks.finish(t.id, "done", `Fixed on ${taskStore.get(t.id)!.task.provider}.`);
  },
]);
res = await request<Conversation[]>("POST", "/tasks/best-of", { conversationId: chat.id, goal: "Fix the cart total rounding", requestId: "best-1" });
const runs = res.data as Conversation[];
check("best of 2: one task per provider", res.status === 201 && runs.length === 2 && runs.map((r) => r.task!.provider).join(",") === "claude,chatgpt", JSON.stringify(runs?.map((r) => r.task?.provider)));
check(
  "…pinned to each provider's strongest model",
  runs.map((r) => r.modelId).join(",") === "claude:claude-opus-5-5,chatgpt:gpt-6.1-sol",
  runs.map((r) => r.modelId).join(","),
);
check(
  "…in one best-of group, under the chat",
  runs.every((r) => r.task!.groupKind === "best-of" && r.task!.group === runs[0]!.task!.group && r.parentId === chat.id) && Boolean(runs[0]!.task!.group),
);
check("…titled by provider", runs.map((r) => r.title).join(" | ") === "Fix the cart total rounding · Claude | Fix the cart total rounding · ChatGPT", runs.map((r) => r.title).join(" | "));
let chatMessages = messages.listByConversation(chat.id);
check(
  "…their cards in the chat, after the request",
  chatMessages.length === 2 && chatMessages[0]!.role === "user" && chatMessages[1]!.parts.filter((p) => p.type === "task").length === 2,
  JSON.stringify(chatMessages.map((m) => m.parts.map((p) => p.type))),
);
res = await request("POST", "/tasks/best-of", { conversationId: chat.id, goal: "Fix the cart total rounding", requestId: "best-1" });
check("the same request id again: the same runs", res.status === 200 && (res.data as Conversation[]).map((r) => r.id).join() === runs.map((r) => r.id).join());

await until(() => runs.every((r) => Boolean(finishOn[r.id])));
finishOn[runs[0]!.id]!();
await until(() => status(runs[0]!.id) === "done");
await sleep(400); // longer than the wake's batching delay
chatMessages = messages.listByConversation(chat.id);
const notices = () => messages.listByConversation(chat.id).flatMap((m) => m.parts).filter((p) => p.type === "notice");
check("one finished: no notice, no wake", notices().length === 0 && sentTo(chat.id).length === 0, JSON.stringify(notices()));
check("…its result still reaches the chat's next turn", conversations.get(chat.id)!.childResults.includes(runs[0]!.id));
finishOn[runs[1]!.id]!();
await until(() => notices().length > 0);
await sleep(400);
const notice = notices()[0];
check(
  "both finished: one notice with the group",
  notices().length === 1 && notice?.type === "notice" && notice.text === "Best of 2 finished" && notice.group === runs[0]!.task!.group,
  JSON.stringify(notices()),
);
check("…and no wake turn", sentTo(chat.id).length === 0, JSON.stringify(sentTo(chat.id)));

// Picked up again and finished again: still one notice.
finishOn[runs[0]!.id] = () => {};
scripts.set(runs[0]!.id, async (t) => void tasks.finish(t.id, "done", "Again."));
await request("POST", `/conversations/${runs[0]!.id}/messages`, { text: "Try once more" });
await until(() => status(runs[0]!.id) === "done" && sentTo(runs[0]!.id).length === 2);
await sleep(200);
check("one notice per group", notices().length === 1, JSON.stringify(notices()));

// Only Claude signed in: two runs on it.
fixture = [CLAUDE, { ...CHATGPT, loggedIn: false }];
res = await request("POST", "/tasks/best-of", { agentId: ana.id, projectId: topic.id, goal: "Fix the cart total once more" });
const twice = res.data as Conversation[];
check(
  "one provider: two runs on it",
  res.status === 201 && twice.length === 2 && twice.every((r) => r.task!.provider === "claude" && r.modelId === "claude:claude-opus-5-5"),
  JSON.stringify(res.data),
);
check("…numbered", twice.map((r) => r.title).join(" | ") === "Fix the cart total once more · Claude 1 | Fix the cart total once more · Claude 2");
check("…top-level, in the project", twice.every((r) => r.parentId === null && r.projectId === topic.id));
for (const run of twice) await until(() => Boolean(finishOn[run.id]));
for (const run of twice) finishOn[run.id]!();
await until(() => twice.every((r) => status(r.id) === "done"));
fixture = [];
res = await request("POST", "/tasks/best-of", { conversationId: chat.id, goal: "Anything" });
check("nobody signed in: refused", res.status === 400, JSON.stringify(res.data));
fixture = [CLAUDE, CHATGPT];
res = await request("POST", "/tasks/best-of", { conversationId: chat.id, goal: "x", providers: ["claude", "gemini"] });
check("unknown provider: refused", res.status === 400);
res = await request("POST", "/tasks/best-of", { conversationId: chat.id, goal: "   " });
check("empty goal: refused", res.status === 400);

// A best-of run stays on its provider at a usage limit (no switch).
const { failover } = await import("./orchestration/failover.ts");
const limited = tasks.create({ agentId: ana.id, goal: "Pinned run", provider: "claude", group: randomUUID(), groupKind: "best-of" });
scripts.set(limited.id, async (t) => {
  check("…pinned: paused, not switched", (await failover(t.id, "claude")) === "paused" && taskStore.get(t.id)!.task.provider === "claude");
});
await until(() => status(limited.id) === "paused");

server.close();
for (const task of conversations.tasks()) if (status(task.id) === "running" || status(task.id) === "needs-input") tasks.stop(task.id);
await until(() => runLoop.count() === 0);
check("nothing left running", runLoop.count() === 0, conversations.tasks().filter((t) => runLoop.isRunning(t.id)).map((t) => `${t.title}: ${t.task?.status}`).join(", "));
taskQueue.stop();
missionWatch.stop();
chatWakes.stop();
console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
