import { constants, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import type { ChatWorkspace, ImportSessionsRequest, ImportSessionsResult, Project, ProjectRepo, ProviderAccount, ProviderId } from "@tot/shared/types";
import { accountDir, accounts, tildePath } from "../accounts/accounts.ts";
import { HttpError } from "../agent/orchestrator.ts";
import { CLAUDE_OPUS, CLAUDE_SONNET } from "../agent/router.ts";
import { appEvents } from "../app-events.ts";
import { agents } from "../data/agents.ts";
import { brains } from "../data/brains.ts";
import { conversations, toPublicConversation } from "../data/conversations.ts";
import { messages } from "../data/messages.ts";
import { settings } from "../data/settings.ts";
import { db } from "../db.ts";
import { projects } from "../projects/projects.ts";
import { projectRepos } from "../projects/repos.ts";
import { claudeEvents } from "./claude.ts";
import { codexEvents } from "./codex.ts";
import { codexTitle, discover, titleLine, type FoundSession } from "./discovery.ts";
import { sessionImports } from "./imports.ts";
import { TranscriptBuilder } from "./transcript.ts";

/**
 * Importing a project's sessions as chats (sessions/discovery.ts finds them). Each becomes a chat in the project that
 * continues the same session: the chat holds its provider, account and session id, so its next message resumes it in
 * place, in the folder it ran in (sessions/imports.ts → the orchestrator's turn input). A session lives in its
 * account's folder, so the chat is bound to the account using that folder; one found in a folder no account uses is
 * copied (never moved or changed) into the chosen account's folder first, unless that account has it already.
 */

const PROVIDER_NAMES: Record<ProviderId, string> = { claude: "Claude Code", chatgpt: "Codex" };
const CLAUDE_MODELS = new Set([CLAUDE_OPUS, CLAUDE_SONNET, "claude-fable-5-1"]);
/** How long an import waits on reading the sessions (a list was just shown, so they're read already). */
const DISCOVERY_BUDGET_MS = 60_000;

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The account a session continues on: the one using its folder, else the chosen one (or the provider's current). */
function accountFor(session: FoundSession, chosen: Partial<Record<ProviderId, string>> | undefined): ProviderAccount {
  const own = session.file.source.account;
  if (own) return own;
  const pick = accounts.get(chosen?.[session.driver]);
  if (pick && pick.driver === session.driver) return pick;
  return accounts.require(accounts.defaultId(session.driver));
}

/**
 * The file the account's CLI resumes: the session's own, or a copy in the account's folder where the CLI looks for it
 * (Claude Code: projects/<folder>/<id>.jsonl; Codex: the same sessions/… path). An existing file there is left as it is.
 */
function sessionFileFor(session: FoundSession, account: ProviderAccount): string {
  if (session.file.source.account?.id === account.id) return session.file.path;
  const from = session.file.path;
  const to =
    session.driver === "claude"
      ? join(accountDir(account), "projects", basename(dirname(from)), basename(from))
      : join(accountDir(account), relative(session.file.source.dir, from));
  if (!existsSync(to)) {
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to, constants.COPYFILE_EXCL);
  }
  return to;
}

/**
 * Where the chat works: the project's main checkout for a session in its primary folder (or below it), the session's
 * own TOT worktree for one that ran in one (kept when the chat is deleted), and nowhere in particular otherwise (a
 * worktree TOT can't give a chat, or another repo's folder): such a chat reads the project as chats did before.
 */
function workspaceFor(session: FoundSession, primary: ProjectRepo | null): ChatWorkspace | null {
  if (!primary || primary.kind !== "folder" || session.place.repoFolder !== primary.source) return null;
  const { worktree, branch } = session.place;
  if (!worktree) return { mode: "checkout" };
  const name = basename(worktree);
  const own = `${primary.source}/.tot-worktrees/${name}`;
  if (dirname(worktree).endsWith("/.tot-worktrees") && branch?.startsWith("tot/") && existsSync(own)) {
    return { mode: "worktree", repo: primary.name, branch, worktree: own, baseBranch: null, created: true, external: true };
  }
  return null;
}

/** The chat's model: Claude's the session's own when TOT offers it, else Opus; Codex's the session's own, else the deep tier's. */
function modelFor(session: FoundSession): string {
  const used = session.summary.model;
  if (session.driver === "claude") return used && CLAUDE_MODELS.has(used) ? used : CLAUDE_OPUS;
  return used || settings.get().models.tiers.deep.chatgpt || "gpt-5.5";
}

function openingNote(session: FoundSession, account: ProviderAccount, workspace: ChatWorkspace | null): string {
  const where = session.place.worktree ? ` in ${tildePath(session.summary.cwd)}${session.place.branch ? ` (${session.place.branch})` : ""}` : "";
  const reads = !workspace && session.place.worktree ? " TOT's tools here read the project; start a task to change files." : "";
  return `Imported from ${PROVIDER_NAMES[session.driver]}${where}, on ${account.name}. Your next message continues this session.${reads}`;
}

async function importOne(session: FoundSession, opts: { project: Project; agentId: string; chosen?: Partial<Record<ProviderId, string>> }): Promise<string> {
  const { project } = opts;
  const account = accountFor(session, opts.chosen);
  const workspace = workspaceFor(session, projectRepos.primary(project.id));
  const model = modelFor(session);
  const title = titleLine(codexTitle(session) ?? session.summary.title ?? session.summary.firstPrompt, 80) || "Imported session";

  // Read first: a session that can't be read leaves nothing behind (no copy, no chat).
  const builder = new TranscriptBuilder({ provider: session.driver, account: account.id });
  const events = session.driver === "claude" ? claudeEvents(session.file.path) : codexEvents(session.file.path);
  for await (const event of events) builder.add(event);
  builder.opening(openingNote(session, account, workspace));
  const sessionPath = sessionFileFor(session, account);

  db.exec("BEGIN");
  try {
    const chat = conversations.create({ agentId: opts.agentId, modelId: `${account.id}:${model}`, title, projectId: project.id, workspace });
    conversations.update(chat.id, { provider: session.driver, providerAccount: account.id, providerSessionId: session.sessionId });
    const first = builder.messages[0]?.createdAt || session.summary.firstAt || Date.now();
    const last = Math.max(builder.messages.at(-1)?.createdAt ?? 0, session.summary.lastAt, first);
    db.prepare(`UPDATE conversations SET created_at = ?, updated_at = ? WHERE id = ?`).run(first, last, chat.id);
    for (const message of builder.messages) messages.insert({ ...message, conversationId: chat.id });
    const added = sessionImports.add({
      conversationId: chat.id,
      projectId: project.id,
      driver: session.driver,
      sessionId: session.sessionId,
      account: account.id,
      sourcePath: session.file.path,
      sessionPath,
      cwd: session.summary.cwd,
      lastActivityAt: last,
      importedAt: Date.now(),
    });
    if (!added) throw new HttpError(409, "Imported already.");
    db.exec("COMMIT");
    brains.setFocus(chat.id, project.brainId);
    const created = conversations.get(chat.id);
    if (created) appEvents.publish({ type: "conversation", conversation: toPublicConversation(created) });
    return chat.id;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

/** POST /api/projects/:id/sessions/import: the chosen sessions, each as a chat, in order; ones that can't be are skipped with why. */
export async function importSessions(projectId: string, request: ImportSessionsRequest): Promise<ImportSessionsResult> {
  const project = projects.get(projectId);
  if (!project) throw new HttpError(404, "Project not found.");
  if (project.archived) throw new HttpError(400, "That project is archived.");
  const keys = Array.isArray(request?.keys) ? [...new Set(request.keys.filter((key): key is string => typeof key === "string"))] : [];
  if (!keys.length) throw new HttpError(400, "Pick the sessions to import.");
  const agent = request.agentId ? agents.get(request.agentId) : agents.first();
  if (!agent) throw new HttpError(404, "Agent not found.");
  for (const [driver, id] of Object.entries(request.accounts ?? {})) {
    if (id && accounts.get(id)?.driver !== driver) throw new HttpError(400, "That account can't continue these sessions.");
  }

  const { sessions } = await discover(projectId, { budgetMs: DISCOVERY_BUDGET_MS });
  const byKey = new Map(sessions.map((session) => [session.key, session]));
  const imported = sessionImports.chats();
  const result: ImportSessionsResult = { imported: [], skipped: [] };
  for (const key of keys) {
    const session = byKey.get(key);
    if (!session) {
      result.skipped.push({ key, reason: "This session isn't in the project's folders any more." });
      continue;
    }
    if (imported.has(key)) {
      result.skipped.push({ key, reason: "Imported already." });
      continue;
    }
    try {
      const conversationId = await importOne(session, { project, agentId: agent.id, chosen: request.accounts });
      result.imported.push({ key, conversationId });
    } catch (err) {
      result.skipped.push({ key, reason: err instanceof HttpError ? err.message : `Couldn't import it: ${errorText(err)}` });
    }
  }
  if (result.imported.length) appEvents.agentChanged(agent.id);
  return result;
}
