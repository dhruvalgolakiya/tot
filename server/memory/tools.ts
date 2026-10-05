import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { agents } from "../data/agents.ts";
import type { ConversationRecord } from "../data/conversations.ts";
import { memories } from "../data/memories.ts";
import { projects } from "../projects/projects.ts";
import { clip, guarded, reply } from "../mcp/results.ts";
import { edit, forget, remember } from "./memory.ts";
import { listFiles, linksIn, projectRepoId, readFile, repoExists, resolveLink, YOU } from "./repo.ts";

/**
 * Memory tools (roadmap module 10): the same names as before, reaching further. Memory is git repos of
 * markdown: "you" (about the user, every chat) and the chat's project's repo (about the code and the work, only
 * in a project chat or task). Writes from parallel tasks queue up on the server, one commit each, so they never
 * conflict. Gated by `memory.enabled` (mcp/server.ts).
 */

const READ_LIMIT = 30_000;

export function registerMemoryTools(server: McpServer, conversation: ConversationRecord): void {
  const project = projects.get(conversation.projectId);
  const projectRepo = project ? projectRepoId(project.slug) : null;
  const actor = () => agents.get(conversation.agentId)?.name.trim() || "An agent";
  /** The repos this chat may see, its project's first (its ids win when the same id is in both). */
  const visible = projectRepo ? [projectRepo, YOU] : [YOU];
  const scopeHint = project
    ? `"you" for facts about the user (the default), "project" for facts about ${project.name}: its code, how to build, test and ship it, conventions, gotchas`
    : `"you" (facts about the user). This chat isn't in a project, so there's no project memory here`;
  const scope = z.enum(["you", "project"]).optional().describe(`Which memory: ${scopeHint}`);

  /** The repo for a scope, or why it can't be used. */
  const repoFor = (which: "you" | "project" | undefined): string => {
    if (which !== "project") return YOU;
    if (!projectRepo) throw new Error('This chat isn\'t in a project, so there\'s no project memory. Save facts about the user with scope "you".');
    return projectRepo;
  };
  const label = (repo: string, path: string) => `${repo}/${path}`;

  server.registerTool(
    "memory_save",
    {
      title: "Remember something",
      description: `Save a durable fact to long-term memory, shared by all of the user's agents: one short sentence, e.g. "Prefers TypeScript over Python"${
        project ? ' or "Tests need TZ=UTC"' : ""
      }. Facts about the user (preferences, personal details, goals, anything they ask you to remember about them) go to scope "you"; facts about the code or the work in this project go to scope "project"${
        project ? "" : " (only in a project chat or task)"
      }. Long documents belong in the wiki instead. Never save secrets or passwords: they're refused.`,
      inputSchema: {
        content: z.string().min(3).max(500).describe("The fact to remember, as one short sentence"),
        scope,
        file: z.string().max(120).optional().describe('A topic file to keep it in, e.g. "people.md" (made if needed and linked from MEMORY.md). Default: MEMORY.md'),
      },
    },
    ({ content, scope: which, file }) =>
      guarded(async () => {
        const repo = repoFor(which);
        const { memory, duplicate } = await remember({ repo, text: content, file, source: `tot://c/${conversation.id}`, actor: actor() });
        if (duplicate) return reply(`Already remembered (${memory.id}) in ${label(memory.repo, memory.path)}: ${memory.content}`);
        return reply(`Saved to memory (${memory.id}) in ${label(memory.repo, memory.path)}: ${memory.content}`);
      }),
  );

  server.registerTool(
    "memory_search",
    {
      title: "Search memory",
      description: `Search long-term memory${project ? ", about the user and this project," : " about the user"} for entries not shown in your prompt. Returns matching entries with their ids and files.`,
      inputSchema: {
        query: z.string().min(1).describe("What to look for, e.g. `favorite programming language`"),
        scope: z.enum(["you", "project", "all"]).optional().describe(project ? "Which memory (default: all)" : 'Only "you" here'),
        limit: z.number().int().min(1).max(50).optional().describe("Maximum results (default 10)"),
      },
    },
    ({ query, scope: which, limit }) =>
      guarded(async () => {
        const repos = which === "you" ? [YOU] : which === "project" ? [repoFor("project")] : visible;
        const found = memories.search(query, { repos, limit: limit ?? 10 });
        return reply(found.length ? found.map((m) => `- (${m.id}) ${m.content} — ${label(m.repo, m.path)}`).join("\n") : "No matching memories.");
      }),
  );

  server.registerTool(
    "memory_update",
    {
      title: "Update memory",
      description: "Rewrite a memory entry by id when it's out of date (ids are in your prompt, or from memory_search).",
      inputSchema: {
        id: z.string().min(1).describe("The entry's id, e.g. 3f2a9c"),
        content: z.string().min(3).max(500).describe("The new text, as one short sentence"),
      },
    },
    ({ id, content }) =>
      guarded(async () => {
        const updated = await edit({ repos: visible, id: id.trim(), text: content, actor: actor() });
        return reply(`Updated memory (${updated.id}) in ${label(updated.repo, updated.path)}: ${updated.content}`);
      }),
  );

  server.registerTool(
    "memory_delete",
    {
      title: "Forget something",
      description: "Delete a memory entry by id (ids are in your prompt, or from memory_search). Do this whenever the user asks you to forget something.",
      inputSchema: { id: z.string().min(1).describe("The entry's id, e.g. 3f2a9c") },
    },
    ({ id }) =>
      guarded(async () => {
        const gone = await forget({ repos: visible, id: id.trim(), actor: actor() });
        return reply(`Forgot memory ${id.trim()} (${gone.repo}).`);
      }),
  );

  server.registerTool(
    "memory_read",
    {
      title: "Read a memory file",
      description:
        'Read a file from memory: MEMORY.md, a topic file it links to ("preferences", "[[people]]", "billing/queries.sql"), to follow its [[links]].',
      inputSchema: {
        path: z.string().min(1).max(200).describe('A file or [[link]], e.g. "MEMORY.md" or "[[preferences]]"'),
        scope,
      },
    },
    ({ path, scope: which }) =>
      guarded(async () => {
        const repo = repoFor(which);
        const file = repoExists(repo) ? resolveLink(repo, path) : null;
        const content = file ? readFile(repo, file) : null;
        if (!file || content === null) {
          const files = repoExists(repo) ? listFiles(repo) : [];
          return reply(`No file "${path}" in ${repo} memory.${files.length ? ` Files: ${files.join(", ")}` : ""}`, true);
        }
        const links = linksIn(content);
        return reply(`${label(repo, file)}\n\n${clip(content.trimEnd(), READ_LIMIT)}${links.length ? `\n\n[Links: ${links.join(", ")}]` : ""}`);
      }),
  );
}
