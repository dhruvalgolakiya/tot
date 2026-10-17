import { homedir } from "node:os";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { brainHints } from "../agent/brain-hints.ts";
import { computerManager, type ActiveComputer, type Screenshot } from "../computer/manager.ts";
import { MCP_TOKEN, VERSION } from "../config.ts";
import { appEvents } from "../app-events.ts";
import { attachedTo } from "../chats/attach.ts";
import { checkpoints } from "../chats/checkpoints.ts";
import { forks } from "../chats/fork.ts";
import { chatSearch } from "../data/chat-search.ts";
import { conversations } from "../data/conversations.ts";
import { messages } from "../data/messages.ts";
import { describeSchedule, routines, validateRoutine } from "../data/routines.ts";
import { settings } from "../data/settings.ts";
import { redactGitHubTokens } from "../github.ts";
import { isThisMachine } from "../net.ts";
import { chatWorkspaces } from "../chats/workspace.ts";
import type { FolderGrant } from "../computer/types.ts";
import { forTools } from "../projects/checkout.ts";
import { registerProjectTools } from "../projects/tools.ts";
import { registerLeadTools } from "../lead/tools.ts";
import { registerMemoryTools } from "../memory/tools.ts";
import { registerTaskTools } from "../tasks/tools.ts";
import { homeRelative } from "../tasks/worktree.ts";
import { taskPorts } from "../worktrees/ports.ts";
import type { ConversationRecord } from "../data/conversations.ts";
import { clip, guarded, isoDay, reply } from "./results.ts";
import { registerSkillTools } from "../skills/tools.ts";
import { registerMailTools } from "./mail-tools.ts";
import { registerWikiTools } from "./wiki-tools.ts";

/**
 * TOT's built-in MCP server: the agent's computer and long-term memory, shared
 * by every provider. Served statelessly at /mcp/<conversationId> — the path
 * scopes tools to one chat (and through it, its agent's computer), and a
 * per-boot bearer token keeps it private to the harness processes TOT spawns.
 */

const EXEC_OUTPUT_LIMIT = 16_000;
const FILE_OUTPUT_LIMIT = 50_000;
const DEFAULT_TIMEOUT_SECONDS = 120;
const MAX_TIMEOUT_SECONDS = 600;


/** Tells the agent when this call had to start or wake the computer. */
function startNote(active: ActiveComputer): string {
  if (active.event === "created") {
    return `[Started a new computer: ${active.summary.label}. Home folder: ${active.backend.home(active.externalId)}]\n`;
  }
  if (active.event === "resumed") {
    return "[Woke the computer up: files are intact, but servers that were running have stopped — restart any you need.]\n";
  }
  return "";
}

/** A screenshot as a tool result: the image for the model, plus a line the UI turns into a picture. */
function screenshotReply(shot: Screenshot, what: string): CallToolResult {
  const note = shot.event === "created" ? "[Started a new computer.]\n" : shot.event === "resumed" ? "[Woke the computer up.]\n" : "";
  return {
    content: [
      {
        type: "text",
        text: `${note}${what}\nScreen is ${shot.width}×${shot.height}; use these pixel coordinates for clicks.\nscreenshot: ${shot.url}`,
      },
      { type: "image", data: shot.png.toString("base64"), mimeType: "image/png" },
    ],
  };
}

function registerDesktopTools(server: McpServer, agentId: string): void {
  const point = {
    x: z.number().int().min(0).describe("X in the latest screenshot's pixels"),
    y: z.number().int().min(0).describe("Y in the latest screenshot's pixels"),
  };

  server.registerTool(
    "computer_screenshot",
    {
      title: "Look at the screen",
      description:
        "Take a screenshot of your computer's desktop. Do this before clicking or typing so you know what's on screen. Coordinates for the other desktop tools are pixels in this image.",
      inputSchema: {},
    },
    () => guarded(async () => screenshotReply(await computerManager.screenshot(agentId), "Here's the screen.")),
  );

  server.registerTool(
    "computer_click",
    {
      title: "Click",
      description: "Click at a point on the desktop (pixels of the latest screenshot). Returns a new screenshot.",
      inputSchema: {
        ...point,
        button: z.enum(["left", "right", "middle"]).optional().describe("Mouse button (default left)"),
        double: z.boolean().optional().describe("Double-click"),
      },
    },
    ({ x, y, button, double }) =>
      guarded(async () =>
        screenshotReply(
          await computerManager.act(agentId, (desktop, id, toScreen) =>
            desktop.click(id, toScreen(x), toScreen(y), { button: button ?? "left", double: Boolean(double) }),
          ),
          `${double ? "Double-clicked" : "Clicked"} at (${x}, ${y}).`,
        ),
      ),
  );

  server.registerTool(
    "computer_type",
    {
      title: "Type text",
      description: "Type text into whatever has keyboard focus (click the field first). Returns a new screenshot.",
      inputSchema: { text: z.string().min(1).max(5000).describe("Text to type") },
    },
    ({ text }) =>
      guarded(async () =>
        screenshotReply(await computerManager.act(agentId, (desktop, id) => desktop.type(id, text)), `Typed ${text.length} characters.`),
      ),
  );

  server.registerTool(
    "computer_key",
    {
      title: "Press keys",
      description:
        'Press a key or shortcut, xdotool-style: "Return", "Tab", "Escape", "BackSpace", "ctrl+l", "ctrl+shift+t", "Page_Down". Separate several presses with spaces. Returns a new screenshot.',
      inputSchema: { keys: z.string().min(1).max(200).describe('Keys, e.g. "ctrl+l" or "Return"') },
    },
    ({ keys }) =>
      guarded(async () =>
        screenshotReply(await computerManager.act(agentId, (desktop, id) => desktop.key(id, keys)), `Pressed ${keys}.`),
      ),
  );

  server.registerTool(
    "computer_scroll",
    {
      title: "Scroll",
      description: "Scroll at a point on the desktop (pixels of the latest screenshot). Returns a new screenshot.",
      inputSchema: {
        ...point,
        direction: z.enum(["up", "down", "left", "right"]),
        amount: z.number().int().min(1).max(30).optional().describe("Wheel steps (default 5)"),
      },
    },
    ({ x, y, direction, amount }) =>
      guarded(async () =>
        screenshotReply(
          await computerManager.act(agentId, (desktop, id, toScreen) =>
            desktop.scroll(id, toScreen(x), toScreen(y), direction, amount ?? 5),
          ),
          `Scrolled ${direction}.`,
        ),
      ),
  );

  server.registerTool(
    "computer_open_url",
    {
      title: "Open a web page",
      description:
        "Open a URL in Chrome on your desktop — use this for sites that need a real browser (logins, forms, heavy JavaScript). Returns a screenshot once the page has had a moment to load.",
      inputSchema: { url: z.string().url().describe("The page to open, e.g. https://example.com") },
    },
    ({ url }) =>
      guarded(async () => {
        if (!/^https?:\/\//i.test(url)) return reply("Only http(s) URLs can be opened.", true);
        return screenshotReply(await computerManager.act(agentId, (desktop, id) => desktop.openUrl(id, url)), `Opened ${url}.`);
      }),
  );
}

/** A file path for the computer tools: in a coding task, relative paths start in its worktree (`base`). */
function resolvePath(path: string, base: string | null): string {
  if (path.startsWith("~/")) return homeRelative(path);
  // A task's own notes (~/tot-tasks/<id>/PLAN.md) live in the computer's home, never in the repo it works on: a
  // model that drops the "~/" (or writes this Mac's home folder in full) still lands there, not in its worktree.
  const notes = /(?:^|\/)(tot-tasks\/.*)$/.exec(path);
  if (notes && (!path.startsWith("/") || path.startsWith(`${homedir()}/tot-tasks/`))) return notes[1]!;
  if (!base || path.startsWith("/") || path === base || path.startsWith(`${base}/`)) return path;
  return `${base}/${path}`;
}

function buildServer(conversation: ConversationRecord): McpServer {
  const { id: conversationId, agentId } = conversation;
  const server = new McpServer(
    { name: "tot", version: VERSION },
    { instructions: "TOT's tools: your own computer for this chat (computer_*) and long-term memory, about the user and per project (memory_*)." },
  );
  const { computer, memory } = settings.get();
  // A coding task works in its own worktree: commands and relative paths start there. So does a chat that picked
  // where it works (its main checkout or its own worktree), once its project's folder can be used (its grant).
  const taskDir = conversation.kind === "task" && conversation.task?.repo?.headSha ? homeRelative(conversation.task.repo.worktree) : null;
  const baseFor = (grant: FolderGrant | null) => taskDir ?? chatWorkspaces.workDir(conversation, grant);

  if (computer.mode !== "off") {
    server.registerTool(
      "computer_exec",
      {
        title: "Run a shell command",
        description:
          "Run a bash command on your computer and get its exit code, stdout and stderr. Commands run non-interactively (no TTY), so pass flags like -y. Every call starts in the home folder unless `cwd` is set; `cd` and exported variables don't carry over between calls. Run long-lived processes such as dev servers in the background with output redirected, e.g. `nohup npm run dev > dev.log 2>&1 &`, then check them with curl.",
        inputSchema: {
          command: z.string().min(1).describe("Bash command, e.g. `ls -la` or `npm test 2>&1 | tail -30`"),
          cwd: z.string().optional().describe("Working directory, relative to the home folder"),
          timeout_seconds: z
            .number()
            .int()
            .min(1)
            .max(MAX_TIMEOUT_SECONDS)
            .optional()
            .describe(`Stop the command after this many seconds (default ${DEFAULT_TIMEOUT_SECONDS})`),
        },
      },
      ({ command, cwd, timeout_seconds }) =>
        guarded(async () => {
          const active = await computerManager.ensure(agentId);
          // The chat's project folder: set up on the computer, or for a folder on this Mac, granted to this command only.
          const project = await forTools(conversation, active);
          // Before the turn's first change, its workspace is checkpointed, so rewinding the chat can put the files back.
          await checkpoints.beforeChange(conversationId);
          const result = await active.backend.exec(active.externalId, command, {
            cwd: cwd ? homeRelative(cwd) : (baseFor(project.grant) ?? undefined),
            timeoutMs: (timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000,
            grant: project.grant,
            // A coding task's commands get its ports: PORT and TOT_PORTS (module 09).
            env: taskPorts.envFor(conversationId),
          });
          computerManager.touch(agentId);
          const sections = [
            `${startNote(active)}${project.note}exit code ${result.exitCode}${result.timedOut ? " (timed out)" : ""} · ${(result.durationMs / 1000).toFixed(1)}s`,
          ];
          // Output goes into the chat and the model's context: never let a GitHub token through.
          if (result.stdout.trim()) sections.push(`--- stdout ---\n${clip(redactGitHubTokens(result.stdout), EXEC_OUTPUT_LIMIT)}`);
          if (result.stderr.trim()) sections.push(`--- stderr ---\n${clip(redactGitHubTokens(result.stderr), EXEC_OUTPUT_LIMIT / 2)}`);
          if (!result.stdout.trim() && !result.stderr.trim()) sections.push("(no output)");
          // Working in a repo the agent has a brain for (~/repos/<folder>, its URL…): point it there once.
          const hint = brainHints(agentId, conversationId, `${command}\n${cwd ?? ""}`);
          if (hint) sections.push(hint);
          return reply(sections.join("\n"));
        }),
    );

    server.registerTool(
      "computer_read_file",
      {
        title: "Read a file",
        description: "Read a text file from your computer. Relative paths start in your working folder (in a task, its worktree); ~/ is the home folder.",
        inputSchema: { path: z.string().min(1).describe("File path, e.g. `app/src/index.ts`") },
      },
      ({ path }) =>
        guarded(async () => {
          const active = await computerManager.ensure(agentId);
          const project = await forTools(conversation, active);
          const content = await active.backend.readFile(active.externalId, resolvePath(path, baseFor(project.grant)), { grant: project.grant });
          computerManager.touch(agentId);
          return reply(`${startNote(active)}${project.note}${clip(redactGitHubTokens(content), FILE_OUTPUT_LIMIT)}`);
        }),
    );

    server.registerTool(
      "computer_write_file",
      {
        title: "Write a file",
        description:
          "Create or overwrite a text file on your computer with the given content. Parent folders are created as needed. Relative paths start in your working folder (in a task, its worktree); ~/ is the home folder.",
        inputSchema: {
          path: z.string().min(1).describe("File path, e.g. `app/index.html`"),
          content: z.string().describe("The complete file content"),
        },
      },
      ({ path, content }) =>
        guarded(async () => {
          const active = await computerManager.ensure(agentId);
          const project = await forTools(conversation, active);
          await checkpoints.beforeChange(conversationId);
          await active.backend.writeFile(active.externalId, resolvePath(path, baseFor(project.grant)), content, { grant: project.grant });
          computerManager.touch(agentId);
          return reply(`${startNote(active)}${project.note}Wrote ${Buffer.byteLength(content)} bytes to ${path}.`);
        }),
    );

    server.registerTool(
      "computer_expose_port",
      {
        title: "Share a web server",
        description:
          "Give the user a URL for a web server running on your computer. Start the server first (in the background) and make sure it listens on 0.0.0.0, then call this and share the returned link.",
        inputSchema: { port: z.number().int().min(1).max(65535).describe("Port the server listens on") },
      },
      ({ port }) =>
        guarded(async () => {
          const url = await computerManager.exposePort(agentId, port);
          return reply(`Port ${port} is available at ${url}\nShare this link with the user.`);
        }),
    );

    server.registerTool(
      "computer_info",
      {
        title: "Describe the computer",
        description: "Describe your computer: kind, home folder, operating system, shared URLs, and whether it has a desktop.",
        inputSchema: {},
      },
      () =>
        guarded(async () => {
          const active = await computerManager.ensure(agentId);
          const os = await active.backend.exec(active.externalId, "uname -srm", { timeoutMs: 15_000 });
          const { summary } = active;
          const lines = [
            `Computer: ${summary.label} (${summary.kind}, ${summary.state})`,
            `Home folder: ${active.backend.home(active.externalId)}`,
            `OS: ${os.stdout.trim() || "unknown"}`,
            summary.desktopUrl ? "Virtual desktop: available (the user can open it from the computer panel)." : "Virtual desktop: none",
            summary.exposedUrls.length
              ? `Shared URLs:\n${summary.exposedUrls.map((entry) => `- port ${entry.port}: ${entry.url}`).join("\n")}`
              : "Shared URLs: none",
          ];
          return reply(`${startNote(active)}${lines.join("\n")}`);
        }),
    );
  }

  if (computer.mode !== "off" && computerManager.hasDesktop(agentId)) registerDesktopTools(server, agentId);

  if (memory.enabled) {
    // Memory repo (module 10): memory_save / _search / _update / _delete / _read over git repos of markdown.
    registerMemoryTools(server, conversation);

    registerWikiTools(server, agentId, conversationId);

    server.registerTool(
      "chat_search",
      {
        title: "Search earlier chats",
        description:
          "Full-text search over your earlier chats in this workspace (not this one). Returns the best-matching chats with a snippet; read one with chat_read.",
        inputSchema: {
          query: z.string().min(1).describe("Words to look for, e.g. `landing page pricing section`"),
          limit: z.number().int().min(1).max(20).optional().describe("Maximum chats (default 8)"),
        },
      },
      ({ query, limit }) =>
        guarded(async () => {
          const hits = chatSearch.search(agentId, query, { exclude: conversationId, limit: limit ?? 8 });
          if (!hits.length) return reply("No earlier chats match.");
          return reply(
            hits.map((hit) => `- ${hit.conversationId} · “${hit.title}” (${isoDay(hit.updatedAt)})\n  ${hit.snippet}`).join("\n"),
          );
        }),
    );
  }

  // The folders of skills this chat invoked ("/dh-stack …"): their references and scripts, read-only.
  if (messages.skillsUsed(conversationId).length) registerSkillTools(server, conversationId);

  // chat_read always works on this chat (context selection points models at what it left out) and on the
  // chats linked to it (the one it was forked from, its forks, chats attached to its messages); on the
  // workspace's other chats only with memory on.
  server.registerTool(
    "chat_read",
    {
      title: "Read a chat",
      description:
        "Read a chat in this workspace — an earlier one (by the id from chat_search or your recent-chats list) or this one — newest messages first: a page of messages in order, and how to read further back with `before`.",
      inputSchema: {
        chatId: z.string().min(1).describe("The chat id"),
        before: z.string().optional().describe("A message id: read the messages before it (from the hint at the end of the last page)"),
        limit: z.number().int().min(1).max(50).optional().describe("Messages per page (default 20)"),
      },
    },
    ({ chatId, before, limit }) =>
      guarded(async () => {
        const readable = memory.enabled || chatId === conversationId || forks.linked(conversation).has(chatId) || attachedTo(conversationId).has(chatId);
        const chat = readable ? chatSearch.transcript(agentId, chatId, { before, limit }) : null;
        if (!chat) return reply(before ? `No message ${before} in chat ${chatId} in this workspace.` : `No chat with id ${chatId} in this workspace.`, true);
        if (!chat.messages.length) return reply(`“${chat.title}”\n\n(no messages${before ? " before that one" : ""})`);
        const lines = chat.messages.map((m) => `${m.role === "user" ? "User" : "You"}: ${m.text}`);
        const more = chat.earlier
          ? `\n\n[${chat.earlier} earlier message${chat.earlier === 1 ? "" : "s"}. More before: chat_read { chatId: "${chatId}", before: "${chat.messages[0]!.id}" }]`
          : "";
        const range = `messages ${chat.earlier + 1}–${chat.earlier + chat.messages.length} of ${chat.total}, oldest first`;
        return reply(`“${chat.title}”${chatId === conversationId ? " (this chat)" : ""} — ${range}\n\n${lines.join("\n\n")}${more}`);
      }),
  );

  registerRoutineTools(server, agentId);
  registerMailTools(server, agentId, conversationId);
  registerTaskTools(server, conversation);
  registerProjectTools(server, conversation);
  // Module 11: the Lead's tools, in Lead chats only (lane D).
  registerLeadTools(server, conversation);
  return server;
}

const localTime = (time: number | null) =>
  time ? new Date(time).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "never";

function registerRoutineTools(server: McpServer, agentId: string): void {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  server.registerTool(
    "routine_create",
    {
      title: "Schedule a routine",
      description: `Schedule a recurring task that you will run on your own, e.g. a daily briefing or a regular check. Each run starts a new chat where you do the task and summarize the result. Times are in the user's time zone (${zone}). Use this when the user asks for something to happen regularly or at a set time every day.`,
      inputSchema: {
        name: z.string().min(1).max(80).describe('Short name, e.g. "Morning AI news"'),
        prompt: z.string().min(1).max(4000).describe("Exactly what to do on each run, written as instructions to yourself"),
        schedule: z.enum(["daily", "interval"]).describe('"daily" at a time of day, or "interval" every N minutes'),
        time: z.string().optional().describe('For daily: 24h "HH:MM", e.g. "08:30"'),
        days: z.array(z.number().int().min(0).max(6)).optional().describe("For daily: 0=Sun … 6=Sat; omit for every day"),
        every_minutes: z.number().int().optional().describe("For interval: minutes between runs (15 or more)"),
      },
    },
    ({ name, prompt, schedule, time, days, every_minutes }) =>
      guarded(async () => {
        const input = {
          name,
          prompt,
          schedule:
            schedule === "interval"
              ? { kind: "interval" as const, everyMinutes: every_minutes ?? 0 }
              : { kind: "daily" as const, time: time ?? "", ...(days?.length ? { days } : {}) },
        };
        const problem = validateRoutine(input, true);
        if (problem) return reply(problem, true);
        const routine = routines.create(agentId, input);
        appEvents.agentChanged(agentId);
        return reply(
          `Scheduled "${routine.name}" (${routine.id}) ${describeSchedule(routine.schedule)}. Next run: ${localTime(routine.nextRunAt)}.`,
        );
      }),
  );

  server.registerTool(
    "routine_list",
    {
      title: "List routines",
      description: "List your scheduled routines with their ids, schedules and next run times.",
      inputSchema: {},
    },
    () =>
      guarded(async () => {
        const list = routines.list(agentId);
        if (!list.length) return reply("You have no routines yet.");
        return reply(
          list
            .map(
              (r) =>
                `- (${r.id}) ${r.name}: ${describeSchedule(r.schedule)}${r.enabled ? `, next ${localTime(r.nextRunAt)}` : " (paused)"} — ${r.prompt.slice(0, 120)}`,
            )
            .join("\n"),
        );
      }),
  );

  server.registerTool(
    "routine_delete",
    {
      title: "Delete a routine",
      description: "Delete one of your routines by id (see routine_list). Do this when the user asks to stop a recurring task.",
      inputSchema: { id: z.string().min(1) },
    },
    ({ id }) =>
      guarded(async () => {
        const routine = routines.get(id);
        // A project's schedule (module 12) is the project's, changed from its Subscriptions, not here.
        if (!routine || routine.agentId !== agentId || routine.projectId) return reply(`No routine with id ${id}.`, true);
        routines.delete(id);
        appEvents.agentChanged(agentId);
        return reply(`Deleted "${routine.name}".`);
      }),
  );
}

export const mcpRoutes = new Hono();

/** Only the harness processes TOT spawns on this machine may use these tools, even when TOT is on the network. */
function fromThisMachine(c: Context): boolean {
  try {
    return isThisMachine(getConnInfo(c).remote.address);
  } catch {
    return false;
  }
}

mcpRoutes.all("/:conversationId", async (c) => {
  if (!fromThisMachine(c)) return c.json({ error: "Forbidden" }, 403);
  if (c.req.header("authorization") !== `Bearer ${MCP_TOKEN}`) return c.json({ error: "Unauthorized" }, 401);
  const conversationId = c.req.param("conversationId");
  const conversation = conversations.get(conversationId);
  if (!conversation) return c.json({ error: "Unknown chat" }, 404);

  // Stateless: a fresh server + transport per request, answered with plain JSON.
  const server = buildServer(conversation);
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return await transport.handleRequest(c.req.raw);
  } finally {
    void server.close();
  }
});
