import type { KnowledgeUpdate } from "../../../shared/types.ts";
import { HttpError } from "../../agent/orchestrator.ts";
import { appEvents } from "../../app-events.ts";
import { wiki, WikiError } from "../../data/wiki.ts";
import { dreamUndone } from "../../memory/dreaming.ts";
import { undo } from "../../memory/memory.ts";
import { projects } from "../../projects/projects.ts";
import { knowledgeLog, pageHash } from "./log.ts";
import { knowledgeRepo } from "./repos.ts";

/**
 * Module 11, lane C: undoing an auto-update. Its commit is reverted through module 10's undo (a new commit; one
 * that would collide with later changes is refused), which with lane B puts its pages back too. Pages that
 * aren't in git (before lane B) are put back through `wiki.*` from the text the run kept. A page it wrote that
 * someone changed since refuses the whole Undo first, so nobody's later edit is lost.
 */

export async function undoUpdate(projectId: string, updateId: string, actor = "you"): Promise<KnowledgeUpdate> {
  const update = knowledgeLog.get(updateId);
  const project = projects.get(projectId);
  if (!update || !project || update.projectId !== projectId) throw new HttpError(404, "That update isn't in this project's log.");
  if (update.undoneAt) throw new HttpError(409, "That update was undone already.");
  const { commits, pages } = update.undo;
  if (!commits.length && !pages.length) throw new HttpError(409, "That update didn't change anything.");

  const standing = [];
  for (const page of pages) {
    const now = wiki.get(page.id);
    // Deleted since: there's nothing of it to put back.
    if (!now) continue;
    if (pageHash(now) !== page.wrote) throw new HttpError(409, `“${now.title}” changed since this update. Undo that page from its own history instead.`);
    standing.push(page);
  }

  const repo = knowledgeRepo(project);
  // Newest first, each a new commit.
  for (const sha of commits) await undo(repo, sha, actor);
  if (update.trigger === "dreaming" && commits[0]) dreamUndone(repo, commits[0]);

  const stuck: string[] = [];
  for (const page of standing) {
    const now = wiki.get(page.id);
    // The revert put it back already (its page lives in git).
    if (!now || pageHash(now) !== page.wrote) continue;
    try {
      if (page.action === "created") await wiki.delete(page.id);
      else if (page.before) await wiki.update(page.id, { ...(now.pinned ? {} : { title: page.before.title }), summary: page.before.summary, content: page.before.content }, "user");
    } catch (err) {
      if (!(err instanceof WikiError)) console.warn("[tot] undoing a knowledge update couldn't put a page back:", err);
      stuck.push(`“${now.title}” (${err instanceof Error ? err.message : String(err)})`);
    }
  }
  if (pages.length) appEvents.brainChanged(project.brainId, { structure: pages.some((page) => page.action === "created") });
  const undone = knowledgeLog.markUndone(update.id)!;
  // Its commit is reverted either way; say which pages are left to put back by hand.
  if (stuck.length) throw new HttpError(409, `Undone, but these pages couldn't be put back: ${stuck.join(", ")}. Restore them from their history.`);
  return undone;
}
