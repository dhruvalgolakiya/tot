import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { HttpError } from "../agent/orchestrator.ts";
import { runRegistry, type Run } from "../agent/runs.ts";
import { quote } from "../computer/github-login.ts";
import { computerManager } from "../computer/manager.ts";
import { conversations, type ConversationRecord } from "../data/conversations.ts";
import { db, statement, type Row } from "../db.ts";
import { hostGitEnv } from "../git-env.ts";
import { gitWords } from "../landing/git.ts";
import { grantFor } from "../projects/checkout.ts";
import { scrub } from "../trust/shell.ts";
import { chatWorkspaces } from "./workspace.ts";

/**
 * Checkpoints of a chat's workspace (its main checkout or its own worktree), so rewinding the chat can put its
 * files back (chats/rewind.ts). Before a turn's first change (its first computer_exec or computer_write_file), the
 * working tree as it is, tracked and new files alike (ignored ones not), becomes a commit on a private ref,
 * refs/tot/checkpoints/<chat>/<reply>, built in a temporary index: the checkout's own index, branch and stash stay
 * as they are. A turn that never touches the computer has none. In a folder on this Mac TOT's server runs this git
 * itself, as it does to land a task (the agent's sandbox may not write those refs); a clone's runs on the computer.
 */

const GIT_TIMEOUT_MS = 120_000;
/** A working tree with more new (untracked, not ignored) files than this isn't snapshotted: it'd copy all of them. */
const MAX_NEW_FILES = 20_000;
const REFS = "refs/tot/checkpoints";
/** Commits TOT makes for checkpoints carry its own name, whatever the repo's config says. */
const IDENTITY = "export GIT_AUTHOR_NAME=TOT GIT_AUTHOR_EMAIL=tot@localhost GIT_COMMITTER_NAME=TOT GIT_COMMITTER_EMAIL=tot@localhost";

const run = promisify(execFile);

type Chat = Pick<ConversationRecord, "id" | "agentId" | "projectId" | "kind" | "title" | "task"> & Pick<Partial<ConversationRecord>, "workspace">;

/** Where a chat's checkpoints are taken: its working folder, and whether that's a folder on this Mac. Null without a workspace. */
function placeOf(chat: Chat): { dir: string; onMac: boolean } | null {
  if (chat.kind === "task" || !chat.workspace) return null;
  let grant: ReturnType<typeof grantFor> = null;
  try {
    grant = grantFor(chat);
  } catch {
    return null;
  }
  const dir = chatWorkspaces.workDir(chat, grant);
  return dir ? { dir, onMac: Boolean(grant) } : null;
}

const refOf = (chatId: string, replyId: string) => `${REFS}/${chatId}/${replyId}`;

/** A git script in the chat's working folder (from its repo's top). `wake: false` skips a computer that isn't running. */
async function git(chat: Chat, script: string, { wake = true } = {}): Promise<{ code: number; stdout: string; stderr: string } | null> {
  const place = placeOf(chat);
  if (!place) return null;
  const full = `set -e\n${IDENTITY}\ncd "$(git rev-parse --show-toplevel)"\n${script}`;
  if (place.onMac) {
    try {
      const { stdout, stderr } = await run("/bin/bash", ["-c", full], {
        cwd: place.dir,
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 16 * 1024 * 1024,
        env: hostGitEnv({ GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" }),
      });
      return { code: 0, stdout, stderr };
    } catch (err) {
      const failed = err as { code?: unknown; stdout?: string; stderr?: string; message?: string };
      return { code: typeof failed.code === "number" ? failed.code : 1, stdout: failed.stdout ?? "", stderr: failed.stderr || failed.message || "" };
    }
  }
  if (!wake && computerManager.get(chat.agentId)?.state !== "running") return null;
  const active = await computerManager.ensure(chat.agentId);
  const result = await active.backend.exec(active.externalId, full, { cwd: place.dir, timeoutMs: GIT_TIMEOUT_MS });
  computerManager.touch(chat.agentId);
  return { code: result.exitCode, stdout: scrub(result.stdout), stderr: scrub(result.stderr) };
}

/**
 * The working tree into a commit, in a temporary index made from the real one (so unchanged files aren't hashed
 * again); prints its id. Its parent is HEAD at the time (none on an unborn branch).
 */
function snapshot(ref: string): string {
  return [
    `n=$(git ls-files --others --exclude-standard | head -n ${MAX_NEW_FILES + 1} | wc -l | tr -d ' ')`,
    `[ "$n" -le ${MAX_NEW_FILES} ] || { echo "There are more than ${MAX_NEW_FILES} new files." >&2; exit 5; }`,
    `tmp=$(mktemp "\${TMPDIR:-/tmp}/tot-checkpoint.XXXXXX")`,
    `trap 'rm -f "$tmp"' EXIT`,
    `index=$(git rev-parse --git-path index)`,
    `if [ -f "$index" ]; then cp "$index" "$tmp"; else rm -f "$tmp"; fi`,
    `GIT_INDEX_FILE="$tmp" git add -A`,
    `tree=$(GIT_INDEX_FILE="$tmp" git write-tree)`,
    `parent=$(git rev-parse -q --verify 'HEAD^{commit}' || true)`,
    `commit=$(git commit-tree "$tree" \${parent:+-p "$parent"} -m 'TOT checkpoint')`,
    `git update-ref ${quote(ref)} "$commit"`,
    `echo "$commit"`,
  ].join("\n");
}

/** One checkpoint per turn: a turn's tool calls wait for the first one's. */
const taking = new WeakMap<Run, Promise<void>>();

async function take(conversationId: string, replyId: string): Promise<void> {
  const chat = conversations.get(conversationId);
  if (!chat || statement(`SELECT 1 FROM chat_checkpoints WHERE message_id = ?`).get(replyId)) return;
  const result = await git(chat, snapshot(refOf(chat.id, replyId)));
  if (!result) return;
  const sha = result.stdout.trim().split("\n").at(-1) ?? "";
  if (result.code !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) {
    console.warn(`[tot] couldn't checkpoint the workspace of chat ${chat.id}:`, gitWords(result.stderr || result.stdout));
    return;
  }
  db.prepare(`INSERT OR IGNORE INTO chat_checkpoints (message_id, conversation_id, start_sha, created_at) VALUES (?, ?, ?, ?)`).run(
    replyId,
    chat.id,
    sha,
    Date.now(),
  );
}

export const checkpoints = {
  /**
   * Before a computer tool that may change files: the chat's workspace checkpointed, once per turn. A problem is
   * logged and the tool runs anyway (rewinding that turn then can't restore its files).
   */
  async beforeChange(conversationId: string): Promise<void> {
    const turn = runRegistry.activeFor(conversationId);
    if (!turn) return;
    let pending = taking.get(turn);
    if (!pending) {
      pending = take(conversationId, turn.messageId).catch((err) => {
        console.warn(`[tot] couldn't checkpoint the workspace of chat ${conversationId}:`, err instanceof Error ? err.message : err);
      });
      taking.set(turn, pending);
    }
    await pending;
  },

  /** The oldest checkpoint among these replies (the files as they were before the first of them changed any). */
  earliest(conversationId: string, replyIds: string[]): { messageId: string; sha: string } | null {
    if (!replyIds.length) return null;
    const row = db
      .prepare(
        `SELECT message_id, start_sha FROM chat_checkpoints WHERE conversation_id = ? AND message_id IN (${replyIds.map(() => "?").join(", ")}) ORDER BY created_at LIMIT 1`,
      )
      .get(conversationId, ...replyIds) as Row | undefined;
    return row ? { messageId: String(row.message_id), sha: String(row.start_sha) } : null;
  },

  /** Whether files can be put back for this chat at all (it still has a workspace TOT can reach). */
  reachable(chat: Chat): boolean {
    return placeOf(chat) !== null;
  },

  /**
   * Puts the chat's working tree back to checkpoint `sha`: files that are new since go, changed and deleted ones come
   * back, ignored ones stay. Commits made on the branch since are undone too (the branch moves back to where it was;
   * the state before this restore is kept on <chat>/before-rewind). Refuses when the branch has moved elsewhere.
   */
  async restore(chat: Chat, sha: string): Promise<void> {
    if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new HttpError(400, "That checkpoint isn't valid.");
    const script = [
      `cp=${sha}`,
      `git cat-file -e "$cp^{commit}" 2>/dev/null || { echo "The checkpoint is gone from the repo." >&2; exit 4; }`,
      `parent=$(git rev-parse -q --verify "$cp^1" || true)`,
      `head=$(git rev-parse -q --verify 'HEAD^{commit}' || true)`,
      `if [ "$parent" != "$head" ] && ! { [ -n "$parent" ] && [ -n "$head" ] && git merge-base --is-ancestor "$parent" "$head"; }; then`,
      `  echo "The checkout is on other commits now, so its files weren't put back." >&2; exit 4`,
      `fi`,
      `tmp=$(mktemp "\${TMPDIR:-/tmp}/tot-checkpoint.XXXXXX")`,
      `trap 'rm -f "$tmp"' EXIT`,
      `index=$(git rev-parse --git-path index)`,
      `if [ -f "$index" ]; then cp "$index" "$tmp"; else rm -f "$tmp"; fi`,
      `GIT_INDEX_FILE="$tmp" git add -A`,
      // What it is now, in case the user wants it back.
      `now=$(git commit-tree "$(GIT_INDEX_FILE="$tmp" git write-tree)" \${head:+-p "$head"} -m 'TOT: before rewind')`,
      `git update-ref ${quote(`${REFS}/${chat.id}/before-rewind`)} "$now"`,
      `if [ "$parent" != "$head" ]; then git reset -q --soft "$parent"; fi`,
      `GIT_INDEX_FILE="$tmp" git read-tree --reset -u "$cp^{tree}"`,
      `if [ -n "$parent" ]; then git reset -q; else git read-tree --empty; fi`,
    ].join("\n");
    const result = await git(chat, script);
    if (!result) throw new HttpError(409, "This chat's workspace can't be reached, so its files weren't put back.");
    if (result.code !== 0) throw new HttpError(409, gitWords(result.stderr || result.stdout) || "Couldn't put the files back.");
  },

  /** Drops the refs of these replies' checkpoints (their messages are gone). Best effort, and never wakes a computer. */
  async drop(chat: Chat, replyIds: string[]): Promise<void> {
    if (!replyIds.length) return;
    const lines = replyIds.map((id) => `git update-ref -d ${quote(refOf(chat.id, id))} 2>/dev/null || true`);
    await git(chat, lines.join("\n"), { wake: false }).catch(() => null);
  },

  /** Drops every checkpoint ref of a chat being deleted. Best effort, and never wakes a computer. */
  async forget(chat: Chat): Promise<void> {
    const script = `git for-each-ref --format='delete %(refname)' ${quote(`${REFS}/${chat.id}/`)} | git update-ref --stdin`;
    await git(chat, script, { wake: false }).catch(() => null);
  },
};
