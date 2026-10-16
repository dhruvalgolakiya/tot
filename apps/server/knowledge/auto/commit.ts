import { afterChange } from "../../memory/memory.ts";
import { commitAll, git, head, isAncestor, repoDir, subjectText, withRepo, type CommitMessage } from "../../memory/repo.ts";
import { flushRepo, landedIn, watchChanges } from "../store.ts";

/**
 * Module 11, lane C: one run, one commit. A run writes facts through module 10 (one commit) and pages through
 * `wiki.*`, which keeps pages in the same git repo (lane B), each write a commit of its own once it lands (a page
 * write returns before its commit, so `trackWrite` waits for it). Each write is watched (`trackWrite`: the
 * knowledge repo's head before and after), and afterwards the run's commits are squashed into one by "TOT"
 * (`consolidate`), in the repo's turn, only when every commit since the run began is one of its own, in a line,
 * with nothing edited by hand waiting. The squash keeps the pages' `TOT-Page`/`TOT-Author`/`TOT-Chat` trailers,
 * so page history still reads right. Otherwise they stay as they are, and Undo reverts each. A brain whose pages
 * are still in the database (its move failed) makes no page commits, and there's nothing to squash.
 */

const RS = "\x1e";
const US = "\x1f";

interface Commit {
  sha: string;
  parents: number;
  subject: string;
  kind: string | null;
  /** Its page trailers (TOT-Page, -Author, -Chat, -At), kept when it's squashed. */
  pageTrailers: string[];
}

/** Trailers lane B's page history reads, which a squash must carry over. */
const PAGE_TRAILER = /^TOT-(Page|Author|Chat|At):/;

/** Page writes by anyone but TOT's background writer ("keeper": runs, the wiki keeper, Dreaming) are never a run's. */
const byOthers = (commit: Commit) => commit.pageTrailers.some((line) => /^TOT-Author:\s*(agent|user)\b/.test(line));

/** The commits after `from` up to `to`, oldest first. */
async function range(repo: string, from: string, to: string): Promise<Commit[]> {
  const out = await git(repoDir(repo), ["log", "--reverse", `--format=${RS}%H${US}%P${US}%s${US}%b`, `${from}..${to}`]);
  return out
    .split(RS)
    .slice(1)
    .map((record) => {
      const [sha = "", parents = "", subject = "", body = ""] = record.split(US);
      const pageTrailers = body.split("\n").map((line) => line.trim()).filter((line) => PAGE_TRAILER.test(line));
      return { sha, parents: parents.trim().split(" ").filter(Boolean).length, subject, kind: /^TOT-Kind:\s*(\S+)/m.exec(body)?.[1] ?? null, pageTrailers };
    });
}

/**
 * Runs one of a run's writes (synchronous `wiki.*` calls), adding the commits its page changes landed in to `mine`.
 * Only the changes recorded while `write` runs count: a fact, an undo or another run's page committed meanwhile
 * is never taken for the run's (and so never squashed into it, or undone with it).
 */
export async function trackWrite<T>(repo: string, mine: Set<string>, write: () => T | Promise<T>): Promise<Awaited<T>> {
  const watch = watchChanges();
  let pending: T | Promise<T>;
  try {
    pending = write();
  } finally {
    watch.stop();
  }
  const result = await pending;
  // A page write is committed after it returns: wait for it, so its commit counts as the run's.
  await flushRepo(repo);
  for (const change of watch.changes) {
    const sha = landedIn(change.key);
    if (sha) mine.add(sha);
  }
  return result;
}

/** The wiki keeper's commits since `base` for one chat: its page writes there (TOT-Author keeper, TOT-Chat the chat). */
export async function keeperCommits(repo: string, base: string | null, conversationId: string): Promise<Set<string>> {
  await flushRepo(repo);
  const top = await head(repo);
  if (!base || !top || top === base) return new Set();
  const commits = await range(repo, base, top).catch(() => []);
  return new Set(
    commits.filter((commit) => commit.pageTrailers.includes("TOT-Author: keeper") && commit.pageTrailers.includes(`TOT-Chat: ${conversationId}`)).map((commit) => commit.sha),
  );
}

/**
 * Makes the run's commits since `base` one commit with `message`. Returns the run's commits, newest first (one
 * after squashing; none when it changed nothing). `mine`: the commits its own writes made (trackWrite,
 * keeperCommits, a facts commit); anything else since `base` keeps the run's commits as they are.
 */
export async function consolidate(repo: string, base: string | null, message: CommitMessage, mine: Set<string>): Promise<string[]> {
  if (!base) return [];
  // Page writes waiting to be committed land first (outside the repo's turn, where they're committed).
  await flushRepo(repo);
  return withRepo(repo, async () => {
    const dir = repoDir(repo);
    const top = await head(repo);
    if (!top || top === base || !(await isAncestor(dir, base, top))) return [];
    const commits = await range(repo, base, top);
    const own = (commit: Commit) => commit.parents === 1 && !byOthers(commit) && mine.has(commit.sha);
    const ours = commits.filter(own).map((commit) => commit.sha).reverse();
    if (ours.length !== commits.length) return ours;
    if (commits.length === 1 && commits[0]!.subject === subjectText(message.subject, 100)) return ours;
    if ((await git(dir, ["status", "--porcelain"])).trim()) return ours;
    // One Author/Chat/At (the first commit's) and every Page line, so page history keeps who and what.
    const carried: string[] = [];
    const seen = new Set<string>();
    for (const commit of commits) {
      for (const line of commit.pageTrailers) {
        const key = line.startsWith("TOT-Page:") ? line : line.slice(0, line.indexOf(":"));
        if (seen.has(key)) continue;
        seen.add(key);
        carried.push(line);
      }
    }
    await git(dir, ["reset", "-q", "--soft", base]);
    const sha = await commitAll(repo, carried.length ? { ...message, trailers: [...(message.trailers ?? []), ...carried] } : message);
    if (!sha) return [];
    afterChange(repo, sha);
    return [sha];
  });
}
