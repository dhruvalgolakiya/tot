import type { WikiPage } from "../../../shared/types.ts";
import { conversations } from "../../data/conversations.ts";
import { wiki } from "../../data/wiki.ts";
import { quoted } from "../../memory/memory.ts";
import { head } from "../../memory/repo.ts";
import { projects } from "../../projects/projects.ts";
import { consolidate, keeperCommits } from "./commit.ts";
import { knowledgeLog, landingsPending, pageHash, type PageUndo } from "./log.ts";
import { knowledgeRepo } from "./repos.ts";

/**
 * Module 11, lane C: the wiki keeper (agent/wiki-keeper.ts) and project knowledge. For a chat or task in a
 * project, the keeper's new pages go to the project's brain (its knowledge, through `wiki.*`); a task whose
 * landing already updated the knowledge (or is about to) is left alone; and a pass that changes the project's
 * pages is one logged run (trigger "chat"), squashed into one commit by "TOT", with Undo.
 */

export interface ChatRun {
  /** After the keeper applied its updates: logs them, if any were the project's. Never throws. */
  finish(changed: WikiPage[], title: string): Promise<void>;
}

export const keeperKnowledge = {
  /** The brain the keeper's new pages go to for this chat: its project's; null outside a project. */
  homeBrain(conversationId: string): string | null {
    const project = projects.forChat(conversationId);
    return project && !project.archived ? project.brainId : null;
  },

  /** Whether an on-land update covers this task's messages up to `lastAt`, or is queued to. */
  covered(conversationId: string, lastAt: number): boolean {
    if (conversations.get(conversationId)?.kind !== "task") return false;
    if (landingsPending.has(conversationId)) return true;
    const run = knowledgeLog.landedRun(conversationId);
    return Boolean(run && run.at >= lastAt);
  },

  /** Before the keeper applies its updates: what the pages it may change say now, and where the knowledge repo is. */
  async begin(conversationId: string, editable: Iterable<string>): Promise<ChatRun | null> {
    const project = projects.forChat(conversationId);
    if (!project || project.archived) return null;
    const repo = knowledgeRepo(project);
    const before = new Map<string, WikiPage>();
    for (const id of editable) {
      const page = wiki.get(id);
      if (page?.brainId === project.brainId) before.set(id, page);
    }
    const base = await head(repo);
    return {
      async finish(changed, title) {
        try {
          const pages = [...new Map(changed.filter((page) => page.brainId === project.brainId).map((page) => [page.id, page])).values()];
          if (!pages.length) return;
          // Only this pass's own page commits (by the keeper, from this chat) are squashed and undone together.
          const mine = await keeperCommits(repo, base, conversationId);
          const commits = await consolidate(repo, base, { subject: `Knowledge: after the chat ${quoted(title)}`, actor: "TOT", kind: "edit" }, mine);
          const undo: PageUndo[] = pages.map((page) => {
            const was = before.get(page.id);
            const now = wiki.get(page.id) ?? page;
            return { id: page.id, action: was ? "updated" : "created", before: was ? { title: was.title, summary: was.summary, content: was.content } : null, wrote: pageHash(now) };
          });
          const task = conversations.get(conversationId)?.kind === "task";
          knowledgeLog.record({
            projectId: project.id,
            trigger: "chat",
            repoName: null,
            taskId: task ? conversationId : null,
            sha: commits[0] ?? null,
            pages: pages.map((page) => ({ id: page.id, title: page.title, action: before.has(page.id) ? "updated" : "created" })),
            facts: 0,
            summary: `Updated after the chat ${quoted(title, 60)}`,
            error: null,
            undo: { commits, pages: undo },
          });
        } catch (err) {
          console.warn("[tot] couldn't log the wiki keeper's project update:", err instanceof Error ? err.message : err);
        }
      },
    };
  },
};
