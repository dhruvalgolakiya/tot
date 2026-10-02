import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WikiPage } from "../../shared/types.ts";
import { appEvents } from "../app-events.ts";
import { wiki } from "../data/wiki.ts";
import { redactGitHubTokens } from "../github.ts";
import { guarded, isoDay, reply } from "./results.ts";

/** The agent's tools for its workspace wiki. Pages are referenced by id or exact title. */

const PAGE_REF = z.string().min(1).describe("Page id or exact title");

function changed(agentId: string, created = false): void {
  appEvents.publish({ type: "wiki", agentId });
  if (created) appEvents.agentChanged(agentId);
}

function describe(page: WikiPage): string {
  const parent = page.parentId ? wiki.get(page.parentId) : null;
  return [
    `# ${page.title}`,
    page.summary && `_${page.summary}_`,
    `(id ${page.id}${parent ? ` · under “${parent.title}”` : ""} · updated ${isoDay(page.updatedAt)})`,
    "",
    page.content || "(empty)",
  ]
    .filter((line) => line !== "")
    .join("\n");
}

export function registerWikiTools(server: McpServer, agentId: string, conversationId: string): void {
  const notFound = (ref: string) => {
    const guesses = wiki.search(agentId, ref, 3);
    return reply(
      `No wiki page “${ref}”.${guesses.length ? ` Did you mean: ${guesses.map((g) => `“${g.title}” (${g.id})`).join(", ")}?` : ""}`,
      true,
    );
  };

  server.registerTool(
    "wiki_search",
    {
      title: "Search the wiki",
      description:
        "Search your workspace wiki (titles, summaries and content). Without a query, lists every page as an indented outline with ids.",
      inputSchema: { query: z.string().optional().describe("Words to look for, e.g. `deploy staging`; omit to list all pages") },
    },
    ({ query }) =>
      guarded(async () => {
        if (!query?.trim()) {
          const outline = wiki.outline(agentId);
          return reply(outline.map((p) => `${"  ".repeat(p.depth)}- ${p.title} (${p.id})${p.summary ? ` — ${p.summary}` : ""}`).join("\n"));
        }
        const hits = wiki.search(agentId, query, 10);
        if (!hits.length) return reply("No wiki pages match.");
        return reply(hits.map((hit) => `- ${hit.title} (${hit.id})${hit.summary ? ` — ${hit.summary}` : ""}\n  ${hit.snippet}`).join("\n"));
      }),
  );

  server.registerTool(
    "wiki_read",
    {
      title: "Read a wiki page",
      description: "Read one page of your workspace wiki in full.",
      inputSchema: { page: PAGE_REF },
    },
    ({ page }) =>
      guarded(async () => {
        const found = wiki.find(agentId, page);
        return found ? reply(describe(found)) : notFound(page);
      }),
  );

  server.registerTool(
    "wiki_write",
    {
      title: "Write a wiki page",
      description:
        "Create a wiki page, or replace an existing one's content (pass `page`, or reuse its exact title — with `parent` when titles repeat under different parents). Markdown; ```mermaid blocks render as diagrams. Prefer wiki_edit for small changes to long pages. One topic per page; nest related pages with `parent`.",
      inputSchema: {
        title: z.string().min(1).max(120).describe("Page title, short and specific (e.g. `Billing service`, `Run, test & deploy`)"),
        summary: z
          .string()
          .max(300)
          .optional()
          .describe("One line: what's on the page / when to read it. Required for new pages."),
        content: z.string().describe("The full page, in Markdown"),
        page: PAGE_REF.optional().describe("Existing page to overwrite (id or title); omit to create, or to update the page with this title"),
        parent: z.string().optional().describe("Parent page (id or title) to nest this one under"),
      },
    },
    ({ title, summary, page, parent, ...input }) =>
      guarded(async () => {
        const content = redactGitHubTokens(input.content);
        // Without `page`, a page with this title is updated: under `parent` when given, else anywhere (if unambiguous).
        let existing: WikiPage | null;
        if (page) existing = wiki.find(agentId, page);
        else if (parent) existing = wiki.withTitle(agentId, title, wiki.checkParent(agentId, parent, null))[0] ?? null;
        else existing = wiki.find(agentId, title);
        if (page && !existing) return notFound(page);
        if (existing) {
          const updated = wiki.update(
            existing.id,
            { title, summary, content, ...(parent !== undefined ? { parentId: parent || null } : {}) },
            "agent",
            conversationId,
          );
          changed(agentId);
          return reply(`Updated wiki page “${updated.title}” (${updated.id}).`);
        }
        if (!summary?.trim()) return reply("New pages need a one-line `summary` (what's on it / when to read it).", true);
        const created = wiki.create(agentId, { title, summary, content, parentId: parent || null }, "agent", conversationId);
        changed(agentId, true);
        return reply(`Created wiki page “${created.title}” (${created.id}).`);
      }),
  );

  server.registerTool(
    "wiki_edit",
    {
      title: "Edit a wiki page",
      description:
        "Make a targeted change to a wiki page: replaces `old_text` (must appear exactly once) with `new_text`. Pass an empty `old_text` to append `new_text` to the end of the page.",
      inputSchema: {
        page: PAGE_REF,
        old_text: z.string().describe("Exact text to replace (copy it from wiki_read), or empty to append"),
        new_text: z.string().describe("Replacement text (empty to delete old_text)"),
      },
    },
    ({ page, old_text, ...input }) =>
      guarded(async () => {
        const new_text = redactGitHubTokens(input.new_text);
        const found = wiki.find(agentId, page);
        if (!found) return notFound(page);
        let content: string;
        if (!old_text) {
          content = [found.content, new_text.trim()].filter(Boolean).join("\n\n");
        } else {
          const at = found.content.indexOf(old_text);
          if (at === -1) return reply(`“${found.title}” doesn't contain that old_text exactly; wiki_read it and copy the text to replace.`, true);
          if (found.content.indexOf(old_text, at + 1) !== -1) {
            return reply("old_text appears more than once; include more surrounding text so it's unique.", true);
          }
          content = found.content.slice(0, at) + new_text + found.content.slice(at + old_text.length);
        }
        const updated = wiki.update(found.id, { content }, "agent", conversationId);
        changed(agentId);
        return reply(`Edited wiki page “${updated.title}” (${updated.id}).`);
      }),
  );

  server.registerTool(
    "wiki_delete",
    {
      title: "Delete a wiki page",
      description:
        "Delete a wiki page that's obsolete or merged into another (its sub-pages move up a level). The Overview can't be deleted.",
      inputSchema: { page: PAGE_REF },
    },
    ({ page }) =>
      guarded(async () => {
        const found = wiki.find(agentId, page);
        if (!found) return notFound(page);
        wiki.delete(found.id);
        changed(agentId, true);
        return reply(`Deleted wiki page “${found.title}”.`);
      }),
  );
}
