import { Hono, type Context } from "hono";
import type { ImportSessionsRequest, LocalSessionAccount, LocalSessionList } from "@tot/shared/types";
import { accounts } from "../accounts/accounts.ts";
import { HttpError } from "../agent/orchestrator.ts";
import { projects } from "../projects/projects.ts";
import { discover, toLocalSession } from "./discovery.ts";
import { importSessions } from "./import.ts";
import { sessionImports } from "./imports.ts";

/** A project's Claude Code and Codex sessions on this Mac, and importing them as chats. Route docs: packages/shared/types.ts. */
export const sessionRoutes = new Hono();

const QUICK_BUDGET_MS = 1_500;

async function body<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HttpError(400, "Expected a JSON body.");
  }
}

sessionRoutes.get("/projects/:id/sessions", async (c) => {
  const project = projects.get(c.req.param("id"));
  if (!project) throw new HttpError(404, "Project not found.");
  // quick=1 (the project page's hint): what's been read within a moment; the rest is read meanwhile, for next time.
  const { sessions, partial } = await discover(project.id, c.req.query("quick") === "1" ? { budgetMs: QUICK_BUDGET_MS } : {});
  const imported = sessionImports.chats();
  const list: LocalSessionList = {
    sessions: sessions.map((session) => toLocalSession(session, imported)),
    partial,
    lastImportAt: sessionImports.lastImportAt(project.id),
    accounts: accounts
      .list()
      .filter((account) => account.enabled)
      .map((account): LocalSessionAccount => ({ id: account.id, driver: account.driver, name: account.name, isDefault: accounts.defaultId(account.driver) === account.id })),
  };
  return c.json(list);
});

sessionRoutes.post("/projects/:id/sessions/import", async (c) => c.json(await importSessions(c.req.param("id"), await body<ImportSessionsRequest>(c))));
