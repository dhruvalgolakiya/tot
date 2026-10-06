import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WikiPage } from "../../shared/types.ts";
import { appEvents } from "../app-events.ts";
import { brains, type AgentBrain } from "../data/brains.ts";
import { wiki, WikiError } from "../data/wiki.ts";
import { redactGitHubTokens } from "../github.ts";
import { guarded, isoDay, reply } from "./results.ts";

/**
 * The agent's tools for its brains. Reads cover every brain the agent can see
 * unless `brain` narrows them; writes go to the brain named, else the page's own
 * brain, else the chat's focus brain, else the agent's notebook. Pages are
 * referenced by id or exact title.
 */

const PAGE_REF = z.string().min(1).describe("Page id or exact title");
const BRAIN_REF = z
  .string()
  .min(1)
  .optional()
  .describe("Brain name or id (e.g. `acme/web`, or `notebook` for your own); see the brain cards in your instructions");

/** How a brain is named to the agent. */
export const brainLabel = (brain: Pick<AgentBrain, "kind" | "name">) => (brain.kind === "notebook" ? "notebook" : brain.name);

function describe(page: WikiPage, brain: AgentBrain | undefined, showBrain: boolean): string {
  const parent = page.parentId ? wiki.get(page.parentId) : null;
  const where = [
    `id ${page.id}`,
    showBrain && brain && `brain “${brainLabel(brain)}”${brain.access === "read" ? " (read-only)" : ""}`,
    parent && `under “${parent.title}”`,
    `updated ${isoDay(page.updatedAt)}`,
  ].filter(Boolean);
  return [`# ${page.title}`, page.summary && `_${page.summary}_`, `(${where.join(" · ")})`, "", page.content || "(empty)"]
    .filter((line) => line !== "")
    .join("\n");
}

const outlineText = (brainId: string) =>
  wiki
    .outline(brainId)
    .map((p) => `${"  ".repeat(p.depth)}- ${p.title} (${p.id})${p.summary ? ` — ${p.summary}` : ""}${p.repo ? ` [the ${p.repo} repo's docs]` : ""}`)
    .join("\n");

export function registerWikiTools(server: McpServer, agentId: string, conversationId: string): void {
  const mine = () => brains.forAgent(agentId);
  const byId = (id: string) => mine().find((brain) => brain.id === id);

  /** The brain named by `ref`, or an error reply listing the ones the agent has. */
  function pickBrain(ref: string): AgentBrain | ReturnType<typeof reply> {
    const brain = brains.resolve(agentId, ref);
    if (brain) return brain;
    return reply(`No brain “${ref}”. Your brains: ${mine().map(brainLabel).join(", ")}.`, true);
  }
  const isReply = (value: AgentBrain | ReturnType<typeof reply>): value is ReturnType<typeof reply> => !("id" in value);

  /** Where new pages go when no brain is named: the chat's focus, if the agent can write there, else its notebook. */
  function defaultBrain(): AgentBrain {
    const all = mine();
    const focus = brains.focus(conversationId);
    return all.find((brain) => brain.id === focus && brain.access === "write") ?? all[0];
  }

  /**
   * A page by id or title in these brains. A title several brains share (every brain has an
   * "Overview") means the one in the chat's focus brain, else the notebook's, before giving up.
   */
  function findPage(scope: string[], ref: string): WikiPage | null {
    try {
      return wiki.find(scope, ref);
    } catch (err) {
      if (!(err instanceof WikiError)) throw err;
      for (const preferred of [brains.focus(conversationId), mine()[0].id]) {
        if (!preferred || !scope.includes(preferred)) continue;
        const page = wiki.withTitle(preferred, ref);
        if (page.length === 1) return page[0];
      }
      throw err;
    }
  }

  const readOnly = (brain: AgentBrain) =>
    reply(`The “${brainLabel(brain)}” brain is read-only for you. Put this in a brain you can write to (your notebook, or one shared read-write).`, true);

  const notFound = (ref: string, scope: string[]) => {
    const guesses = wiki.search(scope, ref, 3);
    return reply(
      `No wiki page “${ref}”.${guesses.length ? ` Did you mean: ${guesses.map((g) => `“${g.title}” (${g.id})`).join(", ")}?` : ""}`,
      true,
    );
  };

  /** Tells open tabs the brain changed (and its page count, when pages were added or removed). */
  function changed(brain: AgentBrain, created = false): void {
    appEvents.brainChanged(brain.id, { structure: created });
  }

  server.registerTool(
    "wiki_search",
    {
      title: "Search your brains",
      description:
        "Search your brains' wikis (titles, summaries and content) — all of them, or one with `brain`. Without a query, lists the pages of one brain as an indented outline with ids (the chat's focus brain or your notebook unless `brain` is given), and your other brains.",
      inputSchema: {
        query: z.string().optional().describe("Words to look for, e.g. `deploy staging`; omit to list pages"),
        brain: BRAIN_REF,
      },
    },
    ({ query, brain: brainRef }) =>
      guarded(async () => {
        const all = mine();
        const picked = brainRef ? pickBrain(brainRef) : null;
        if (picked && isReply(picked)) return picked;
        if (!query?.trim()) {
          const shown = picked ?? all.find((brain) => brain.id === brains.focus(conversationId)) ?? all[0];
          const others = all.filter((brain) => brain.id !== shown.id);
          return reply(
            [
              `Pages of the “${brainLabel(shown)}” brain:`,
              outlineText(shown.id),
              others.length &&
                `\nYour other brains (wiki_search with \`brain\` to list their pages):\n${others
                  .map((b) => `- ${brainLabel(b)} — ${b.pageCount} pages${b.description ? ` — ${b.description}` : ""}${b.access === "read" ? " (read-only)" : ""}`)
                  .join("\n")}`,
            ]
              .filter(Boolean)
              .join("\n"),
          );
        }
        const scope = picked ? [picked.id] : all.map((brain) => brain.id);
        const hits = wiki.search(scope, query, 12);
        if (!hits.length) return reply(picked ? `No pages in “${brainLabel(picked)}” match.` : "No wiki pages match in any of your brains.");
        return reply(
          hits
            .map((hit) => {
              const brain = scope.length > 1 ? byId(hit.brainId) : undefined;
              return `- ${hit.title} (${hit.id})${brain ? ` [${brainLabel(brain)}]` : ""}${hit.summary ? ` — ${hit.summary}` : ""}\n  ${hit.snippet}`;
            })
            .join("\n"),
        );
      }),
  );

  server.registerTool(
    "wiki_read",
    {
      title: "Read a wiki page",
      description: "Read one page in full, from any of your brains (pass `brain` when titles repeat across brains, or use the id).",
      inputSchema: { page: PAGE_REF, brain: BRAIN_REF },
    },
    ({ page, brain: brainRef }) =>
      guarded(async () => {
        const picked = brainRef ? pickBrain(brainRef) : null;
        if (picked && isReply(picked)) return picked;
        const all = mine();
        const scope = picked ? [picked.id] : all.map((brain) => brain.id);
        const found = findPage(scope, page);
        return found ? reply(describe(found, byId(found.brainId), all.length > 1)) : notFound(page, scope);
      }),
  );

  server.registerTool(
    "wiki_write",
    {
      title: "Write a wiki page",
      description:
        "Create a wiki page, or replace an existing one's content (pass `page`, or reuse its exact title — with `parent` when titles repeat under different parents). Put it in the brain it's about with `brain` (default: the chat's focus brain, else your notebook). Markdown; ```mermaid blocks render as diagrams. Prefer wiki_edit for small changes to long pages. One topic per page; nest related pages with `parent`.",
      inputSchema: {
        title: z.string().min(1).max(120).describe("Page title, short and specific (e.g. `Billing service`, `Run, test & deploy`)"),
        summary: z
          .string()
          .max(300)
          .optional()
          .describe("One line: what's on the page / when to read it. Required for new pages."),
        content: z.string().describe("The full page, in Markdown"),
        page: PAGE_REF.optional().describe("Existing page to overwrite (id or title); omit to create, or to update the page with this title"),
        parent: z.string().optional().describe("Parent page (id or title, in the same brain) to nest this one under"),
        brain: BRAIN_REF,
      },
    },
    ({ title, summary, page, parent, brain: brainRef, ...input }) =>
      guarded(async () => {
        const content = redactGitHubTokens(input.content);
        const picked = brainRef ? pickBrain(brainRef) : null;
        if (picked && isReply(picked)) return picked;
        // An existing page named by `page` decides the brain; otherwise the named or default one does.
        let existing: WikiPage | null = null;
        let target: AgentBrain;
        if (page) {
          const scope = picked ? [picked.id] : mine().map((brain) => brain.id);
          existing = findPage(scope, page);
          if (!existing) return notFound(page, scope);
          target = byId(existing.brainId)!;
        } else {
          target = picked ?? defaultBrain();
          // Without `page`, a page with this title in the target brain is updated: under `parent` when given, else anywhere (if unambiguous).
          existing = parent
            ? (wiki.withTitle(target.id, title, wiki.checkParent(target.id, parent, null))[0] ?? null)
            : wiki.find(target.id, title);
        }
        if (target.access !== "write") return readOnly(target);
        const where = mine().length > 1 ? ` in “${brainLabel(target)}”` : "";
        if (existing) {
          const updated = wiki.update(
            existing.id,
            { title, summary, content, ...(parent !== undefined ? { parentId: parent || null } : {}) },
            "agent",
            conversationId,
          );
          changed(target);
          return reply(`Updated wiki page “${updated.title}” (${updated.id})${where}.`);
        }
        if (!summary?.trim()) return reply("New pages need a one-line `summary` (what's on it / when to read it).", true);
        const created = wiki.create(target.id, { title, summary, content, parentId: parent || null }, "agent", conversationId);
        changed(target, true);
        return reply(`Created wiki page “${created.title}” (${created.id})${where}.`);
      }),
  );

  server.registerTool(
    "wiki_edit",
    {
      title: "Edit a wiki page",
      description:
        "Make a targeted change to a wiki page in any brain you can write to: replaces `old_text` (must appear exactly once) with `new_text`. Pass an empty `old_text` to append `new_text` to the end of the page.",
      inputSchema: {
        page: PAGE_REF,
        old_text: z.string().describe("Exact text to replace (copy it from wiki_read), or empty to append"),
        new_text: z.string().describe("Replacement text (empty to delete old_text)"),
        brain: BRAIN_REF,
      },
    },
    ({ page, old_text, brain: brainRef, ...input }) =>
      guarded(async () => {
        const new_text = redactGitHubTokens(input.new_text);
        const picked = brainRef ? pickBrain(brainRef) : null;
        if (picked && isReply(picked)) return picked;
        const scope = picked ? [picked.id] : mine().map((brain) => brain.id);
        const found = findPage(scope, page);
        if (!found) return notFound(page, scope);
        const brain = byId(found.brainId)!;
        if (brain.access !== "write") return readOnly(brain);
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
        changed(brain);
        return reply(`Edited wiki page “${updated.title}” (${updated.id}).`);
      }),
  );

  server.registerTool(
    "wiki_delete",
    {
      title: "Delete a wiki page",
      description:
        "Delete a wiki page that's obsolete or merged into another (its sub-pages move up a level). A brain's Overview can't be deleted.",
      inputSchema: { page: PAGE_REF, brain: BRAIN_REF },
    },
    ({ page, brain: brainRef }) =>
      guarded(async () => {
        const picked = brainRef ? pickBrain(brainRef) : null;
        if (picked && isReply(picked)) return picked;
        const scope = picked ? [picked.id] : mine().map((brain) => brain.id);
        const found = findPage(scope, page);
        if (!found) return notFound(page, scope);
        const brain = byId(found.brainId)!;
        if (brain.access !== "write") return readOnly(brain);
        wiki.delete(found.id, "agent", conversationId);
        changed(brain, true);
        return reply(`Deleted wiki page “${found.title}”.`);
      }),
  );
}
