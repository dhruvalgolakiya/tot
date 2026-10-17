import type { ChatWorkspace, Project, TaskRepo, TaskSetup } from "@tot/shared/types";
import { HttpError } from "../agent/orchestrator.ts";
import { appEvents } from "../app-events.ts";
import { quote } from "../computer/github-login.ts";
import { computerManager } from "../computer/manager.ts";
import type { FolderGrant } from "../computer/types.ts";
import { conversations, toPublicConversation, type ConversationRecord } from "../data/conversations.ts";
import { checkout, grantFor } from "../projects/checkout.ts";
import { projects } from "../projects/projects.ts";
import { projectRepos, type RepoRecord } from "../projects/repos.ts";
import { homeRelative, inFolder, planRepo, worktrees } from "../tasks/worktree.ts";
import { worktreeSetup } from "../worktrees/setup.ts";

/**
 * Where a chat in a code project works (like T3 Code's thread target), picked in the composer before its first
 * message: the project's main checkout (a folder project's folder on this Mac, a GitHub project's clone in
 * ~/projects/<slug>), or a worktree of its own on a new tot/… branch, made on its first turn the way a task's is
 * (planRepo, worktrees.ensure, then the project's setup). Its commands start there, and through its folder grant
 * it may change only that: the checkout (minus git's config and hooks), or its own worktree and branch. Chats from
 * before keep reading the project's folder only, and tasks are unchanged. Always the project's primary repo.
 */

const WORKTREES = "/.tot-worktrees/";
const DEFAULT_TITLE = "New chat";

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

type Chat = Pick<ConversationRecord, "id" | "agentId" | "projectId" | "kind" | "title" | "task"> & Pick<Partial<ConversationRecord>, "workspace">;
type Worktree = Extract<ChatWorkspace, { mode: "worktree" }>;

/** A chat's own worktree, if it works in one (tasks never do here: theirs is TaskInfo.repo). */
function worktreeOf(chat: Chat): Worktree | null {
  return chat.kind !== "task" && chat.workspace?.mode === "worktree" ? chat.workspace : null;
}

/** The repo a chat works in: the one its worktree names, or the project's primary. */
function repoOf(project: Project, workspace: ChatWorkspace): RepoRecord | null {
  return (workspace.mode === "worktree" ? projectRepos.get(project.id, workspace.repo) : null) ?? projectRepos.primary(project.id);
}

/** A worktree chat's branch as worktrees.ts takes it (a task's repo, without a head yet). */
function asRepo(source: string, workspace: Worktree): TaskRepo {
  const worktree = workspace.worktree!;
  return {
    source,
    folder: worktree.slice(0, worktree.lastIndexOf(WORKTREES)),
    baseBranch: workspace.baseBranch ?? "",
    branch: workspace.branch!,
    worktree,
    headSha: null,
  };
}

function publish(record: ConversationRecord | null): void {
  if (record) appEvents.publish({ type: "conversation", conversation: toPublicConversation(record) });
}

/** How many commits the branch has beyond its base (local first in a folder on this Mac, as baseRef does); null when unknown. */
async function commitsAhead(agentId: string, repo: TaskRepo, grant: FolderGrant | null): Promise<number | null> {
  const bases = [repo.baseBranch, `origin/${repo.baseBranch}`];
  if (!grant) bases.reverse();
  const script = `for b in ${bases.map(quote).join(" ")}; do if git rev-parse --verify --quiet "$b^{commit}" >/dev/null; then git rev-list --count "$b..${repo.branch.replace(/[^\w./-]/g, "")}"; exit; fi; done; exit 1`;
  const active = await computerManager.ensure(agentId);
  const result = await active.backend.exec(active.externalId, script, { cwd: homeRelative(repo.folder), timeoutMs: 30_000, grant });
  const count = Number(result.stdout.trim());
  return result.exitCode === 0 && Number.isInteger(count) ? count : null;
}

/** Makes the chat's worktree, alone for the chat (worktrees.forTask): names its branch first, keeps the name after. */
async function makeNow(chatId: string, text: string): Promise<{ chat: ConversationRecord; setup: TaskSetup | null }> {
  let chat = conversations.get(chatId);
  if (!chat) throw new Error("This chat is gone.");
  let workspace = worktreeOf(chat);
  if (!workspace || workspace.created) return { chat, setup: null };
  const project = projects.get(chat.projectId);
  const own = project ? repoOf(project, workspace) : null;
  if (!project || !own) throw new Error("This chat isn't in a project with code any more.");
  if (project.archived) throw new Error(`The ${project.name} project is archived.`);
  if (!workspace.branch || !workspace.worktree) {
    // tot/<the chat's title, or else its first words>-<4 hex>: the title isn't made yet on the first turn.
    const name = chat.title !== DEFAULT_TITLE ? chat.title : text.split(/\s+/).slice(0, 6).join(" ");
    const planned = inFolder(planRepo(own.source, name.trim() ? name : "chat", own.defaultBranch ?? undefined), projectRepos.folder(own));
    workspace = { ...workspace, branch: planned.branch, worktree: planned.worktree };
    chat = conversations.update(chatId, { workspace })!;
  }
  // The project's folder on the computer (a clone, or a folder on this Mac made ready for worktrees), then the worktree.
  await checkout.ensure(chat.agentId, project, own);
  const grant = grantFor(chat);
  const { repo, created } = await worktrees.ensure(chat.agentId, asRepo(own.source, workspace), grant);
  // Set up only when this call made it, as for tasks.
  const setup = created ? await worktreeSetup.forChat(chat.agentId, project, repo, grant) : null;
  chat = conversations.update(chatId, { workspace: { ...workspace, baseBranch: repo.baseBranch, created: true } })!;
  publish(chat);
  return { chat, setup };
}

export const chatWorkspaces = {
  /**
   * POST /api/conversations: the workspace a new chat asked for, checked; null when it asked for none. Only in a
   * project with code; a new worktree in a folder on this Mac needs it usable for tasks (allowed, a git repo, a
   * local computer), as a task there would.
   */
  forNew(agentId: string, project: Project | null, mode: unknown): ChatWorkspace | null {
    if (mode === undefined || mode === null) return null;
    if (mode !== "checkout" && mode !== "worktree") throw new HttpError(400, `A chat works in "checkout" or "worktree", not "${String(mode)}".`);
    const own = project && project.kind !== "none" ? projectRepos.primary(project.id) : null;
    if (!project || !own) throw new HttpError(400, "Only a chat in a project with code picks where it works.");
    if (mode === "checkout") return { mode };
    if (own.kind === "folder") checkout.usableRepoFolder(agentId, project, own, { forTasks: true });
    return { mode, repo: own.name, branch: null, worktree: null, baseBranch: null, created: false };
  },

  /**
   * Before a chat's turn: a worktree chat's worktree made, once (one at a time per chat, so two quick messages
   * don't both make it). A problem doesn't stop the turn: the user gets a notice and the agent a note.
   */
  async prepare(chat: ConversationRecord, text: string): Promise<{ chat: ConversationRecord; notice: string | null; note: string }> {
    const workspace = worktreeOf(chat);
    if (!workspace || workspace.created) return { chat, notice: null, note: "" };
    try {
      const made = await worktrees.forTask(chat.id, () => makeNow(chat.id, text));
      const setup = made.setup;
      if (setup?.state === "failed") {
        const what = setup.command ? ` (${setup.command})` : "";
        return {
          chat: made.chat,
          notice: `Setting up this chat's worktree${what} failed:\n${setup.error ?? "no output"}`,
          note: `[Your worktree's setup${what} failed; fix it or work around it:\n${setup.error ?? "no output"}]`,
        };
      }
      return { chat: made.chat, notice: null, note: setup?.error ? `[About your worktree: ${setup.error}]` : "" };
    } catch (err) {
      const reason = errorText(err);
      console.warn(`[tot] couldn't make the worktree of chat ${chat.id}:`, reason);
      return {
        chat: conversations.get(chat.id) ?? chat,
        notice: `Couldn't make this chat's worktree: ${reason}`,
        note: `[Your worktree couldn't be made (${reason}). Don't change the project's files until it is; tell the user.]`,
      };
    }
  },

  /**
   * Where a chat's commands start and relative paths resolve: its worktree once made, or the main checkout (a
   * folder on this Mac only with its writable grant, a GitHub project's clone always). Null for any other chat.
   */
  workDir(chat: Chat, grant: FolderGrant | null): string | null {
    const workspace = chat.kind === "task" ? null : chat.workspace;
    const project = workspace ? projects.get(chat.projectId) : null;
    const own = project && workspace ? repoOf(project, workspace) : null;
    if (!workspace || !own) return null;
    if (workspace.mode === "worktree") {
      if (!workspace.created || !workspace.worktree) return null;
      return own.kind === "folder" && !grant?.task ? null : homeRelative(workspace.worktree);
    }
    if (own.kind === "folder") return grant?.write ? grant.folder : null;
    return homeRelative(projectRepos.folder(own));
  },

  /**
   * Deleting a worktree chat: its worktree goes (work in it that wasn't committed too, as the user asked), and its
   * branch goes only when it has nothing beyond its base and was never pushed; otherwise the branch stays. Null
   * when the chat had no worktree to remove, or only one it found (an imported session's), which stays.
   */
  async remove(chat: ConversationRecord): Promise<{ branchKept: boolean } | null> {
    const workspace = worktreeOf(chat);
    if (!workspace?.created || !workspace.branch || !workspace.worktree || workspace.external) return null;
    return worktrees.forTask(chat.id, async () => {
      const project = projects.get(chat.projectId);
      const own = project ? repoOf(project, workspace) : null;
      const grant = grantFor(chat);
      const repo = asRepo(own?.source ?? "", workspace);
      const ahead = await commitsAhead(chat.agentId, repo, grant).catch(() => null);
      const { branchDeleted } = await worktrees.remove(chat.agentId, repo, { force: true, deleteBranch: ahead === 0, grant });
      return { branchKept: !branchDeleted };
    });
  },
};
