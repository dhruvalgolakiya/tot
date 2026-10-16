import type { KnowledgeUpdate, Project, WikiPage } from "@tot/shared/types";
import { appEvents } from "../../app-events.ts";
import { memories } from "../../data/memories.ts";
import { wiki, WikiError } from "../../data/wiki.ts";
import { repoEntries } from "../../memory/index.ts";
import { change, ensureRepo, entryFileFits, OVERFLOW_FILE, quoted } from "../../memory/memory.ts";
import { ENTRY_FILE, formatEntry, head, insertEntry, linkFromEntry, newId, readFile, today, writeFile, type CommitMessage } from "../../memory/repo.ts";
import { consolidate, trackWrite } from "./commit.ts";
import { pageHash, type RunUndo } from "./log.ts";
import type { KnowledgeOp, PageSnapshot, Refusal, Shown } from "./prompt.ts";
import { knowledgeRepo } from "./repos.ts";

/**
 * Module 11, lane C: applying an update's checked operations to the project's knowledge. Pages go through
 * `wiki.*` (by "keeper", TOT's background writer), each only if it still says what the model was shown; facts
 * go through module 10 as one commit; then the run's commits become one (commit.ts). What Undo needs is kept:
 * the run's commits, and each page's text before it.
 */

export interface Applied {
  pages: KnowledgeUpdate["pages"];
  facts: number;
  /** The run's commit (null when nothing changed in git), and all of them, newest first, if it couldn't squash them. */
  sha: string | null;
  undo: RunUndo;
  refused: Refusal[];
  /** One line per change, for the commit's body. */
  details: string[];
}

export interface ApplyOptions {
  /** The commit's subject: "Knowledge: after “Fix cart”". */
  subject: string;
  /** The chat or task the pages are credited to (WikiPage.conversationId). */
  conversationId: string | null;
  /** New facts' source: "tot://c/<task>", or "tot". */
  factSource: string;
  /** Operations refused before applying (checkOps), for the commit's body. */
  skipped?: Refusal[];
}

const unchanged = (seen: PageSnapshot, now: WikiPage) => seen.title === now.title && seen.summary === now.summary && seen.content === now.content;

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Applies what checked out; anything that no longer does (a page edited meanwhile, a title clash) is refused on its own. */
export async function applyOps(project: Project, ops: KnowledgeOp[], shown: Shown, opts: ApplyOptions): Promise<Applied> {
  const repo = knowledgeRepo(project);
  await ensureRepo(repo);
  const base = await head(repo);
  const mine = new Set<string>();
  const refused: Refusal[] = [];
  const details: string[] = [];
  const pages: Applied["pages"] = [];
  const undo: RunUndo = { commits: [], pages: [] };

  for (const op of ops) {
    if (op.op !== "page_update" && op.op !== "page_create") continue;
    try {
      if (op.op === "page_update") {
        const seen = shown.pages.get(op.id)!;
        const now = wiki.get(op.id);
        if (!now) {
          refused.push({ op, reason: `“${seen.title}” was deleted meanwhile.` });
          continue;
        }
        // Edited (by the user, a chat, another run) since the model read it: never overwrite that.
        if (!unchanged(seen, now)) {
          refused.push({ op, reason: `“${now.title}” changed since TOT read it.` });
          continue;
        }
        if (now.content === op.content && (op.summary ?? now.summary) === now.summary) continue;
        const page = await trackWrite(repo, mine, () => wiki.update(op.id, { content: op.content, ...(op.summary ? { summary: op.summary } : {}) }, "keeper", opts.conversationId));
        pages.push({ id: page.id, title: page.title, action: "updated" });
        undo.pages.push({ id: page.id, action: "updated", before: { title: now.title, summary: now.summary, content: now.content }, wrote: pageHash(page) });
        details.push(`- updated page “${page.title}”`);
      } else {
        const page = await trackWrite(repo, mine, () =>
          wiki.create(shown.brainId, { title: op.title, summary: op.summary, content: op.content, parentId: op.parent }, "keeper", opts.conversationId),
        );
        pages.push({ id: page.id, title: page.title, action: "created" });
        undo.pages.push({ id: page.id, action: "created", before: null, wrote: pageHash(page) });
        details.push(`- created page “${page.title}”${op.parent ? ` under “${shown.index.get(op.parent) ?? "?"}”` : ""}`);
      }
    } catch (err) {
      // A clashing title, an over-long summary: that one is skipped, the rest go on.
      if (!(err instanceof WikiError)) console.warn("[tot] a knowledge update skipped a page:", errorText(err));
      refused.push({ op, reason: errorText(err) });
    }
  }

  const factOps = ops.filter((op): op is Extract<KnowledgeOp, { op: "fact_add" | "fact_update" }> => op.op === "fact_add" || op.op === "fact_update");
  const message = (lines: string[]): CommitMessage => {
    const skipped = [...(opts.skipped ?? []), ...refused];
    return {
      subject: opts.subject,
      body: [...lines, skipped.length ? `Skipped ${skipped.length} that didn't check out: ${skipped.map((r) => r.reason).join(" ")}` : ""].filter(Boolean).join("\n"),
      actor: "TOT",
      kind: "edit",
    };
  };
  let facts = 0;
  if (factOps.length) {
    try {
      const { result, sha } = await change(
        repo,
        () => {
          const entries = repoEntries(repo);
          const taken = new Set([...memories.ids(), ...entries.map((entry) => entry.id)]);
          const texts = new Set(entries.map((entry) => entry.text.toLowerCase()));
          const lines: string[] = [];
          let count = 0;
          // Updates first, in place, so line numbers stay right; then additions.
          const edits = new Map<string, Map<number, string>>();
          for (const op of factOps) {
            if (op.op !== "fact_update") continue;
            const entry = entries.find((candidate) => candidate.key === op.id);
            if (!entry || entry.text !== shown.facts.get(op.id)) {
              refused.push({ op, reason: `Fact ${op.id} changed meanwhile.` });
              continue;
            }
            if (entry.text === op.text) continue;
            const id = entry.derived ? newId(taken) : entry.id;
            taken.add(id);
            texts.add(op.text.toLowerCase());
            if (!edits.has(entry.path)) edits.set(entry.path, new Map());
            edits.get(entry.path)!.set(entry.line, formatEntry({ ...entry, text: op.text, id, added: entry.added ?? today() }));
            lines.push(`- updated fact ${op.id}: ${quoted(entry.text)} → ${quoted(op.text)}`);
            count++;
          }
          for (const [path, changes] of edits) {
            const content = (readFile(repo, path) ?? "").split("\n");
            for (const [line, text] of changes) content[line] = text;
            writeFile(repo, path, content.join("\n"));
          }
          for (const op of factOps) {
            if (op.op !== "fact_add") continue;
            if (texts.has(op.text.toLowerCase())) {
              refused.push({ op, reason: "Already a fact." });
              continue;
            }
            texts.add(op.text.toLowerCase());
            const id = newId(taken);
            taken.add(id);
            const line = formatEntry({ text: op.text, id, source: opts.factSource, added: today() });
            // MEMORY.md is loaded in every chat: once it's full, facts go to notes.md (as module 10 does).
            const path = entryFileFits(readFile(repo, ENTRY_FILE) ?? "", line) ? ENTRY_FILE : OVERFLOW_FILE;
            writeFile(repo, path, insertEntry(path, readFile(repo, path), line));
            if (path !== ENTRY_FILE) writeFile(repo, ENTRY_FILE, linkFromEntry(readFile(repo, ENTRY_FILE) ?? "", path));
            lines.push(`- added fact ${quoted(op.text)}`);
            count++;
          }
          return { lines, count };
        },
        (made) => (made.count ? message([...details, ...made.lines]) : null),
      );
      if (sha) mine.add(sha);
      facts = result.count;
      details.push(...result.lines);
    } catch (err) {
      // The pages stand; the facts are refused together (nothing of them was written).
      console.warn("[tot] a knowledge update couldn't write its facts:", errorText(err));
      for (const op of factOps) refused.push({ op, reason: `Couldn't write facts: ${errorText(err)}` });
    }
  }

  undo.commits = await consolidate(repo, base, message(details), mine);
  if (pages.length) appEvents.brainChanged(shown.brainId, { structure: pages.some((page) => page.action === "created") });
  return { pages, facts, sha: undo.commits[0] ?? null, undo, refused, details };
}
