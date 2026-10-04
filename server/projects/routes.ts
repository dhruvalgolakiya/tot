import { Hono, type Context } from "hono";
import type { CreateProjectRequest, UpdateProjectRequest } from "../../shared/types.ts";
import { learnRepo } from "../agent/learn-repo.ts";
import { HttpError } from "../agent/orchestrator.ts";
import { agents } from "../data/agents.ts";
import { conversations, toPublicConversation } from "../data/conversations.ts";
import { appEvents } from "../app-events.ts";
import { checkout } from "./checkout.ts";
import { recentGitFolders } from "./folders.ts";
import { projects } from "./projects.ts";

/** Projects (roadmap module 06). Route docs: shared/types.ts. */
export const projectRoutes = new Hono();

async function body<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HttpError(400, "Expected a JSON body.");
  }
}

function found<T>(value: T | null | undefined, message = "Project not found."): T {
  if (value === null || value === undefined) throw new HttpError(404, message);
  return value;
}

projectRoutes.get("/projects", (c) => c.json(projects.list({ archived: c.req.query("archived") === "1" })));

/** Git folders on this Mac for the New project picker. */
projectRoutes.get("/projects/folders/recent", (c) => c.json(recentGitFolders()));

projectRoutes.post("/projects", async (c) => c.json(projects.create(await body<CreateProjectRequest>(c)), 201));

projectRoutes.patch("/projects/:id", async (c) => c.json(projects.update(c.req.param("id"), await body<UpdateProjectRequest>(c))));

projectRoutes.delete("/projects/:id", (c) => c.json(projects.archive(c.req.param("id"))));

/** The user's OK for a folder project (the consent dialog). */
projectRoutes.post("/projects/:id/grant", (c) => c.json(projects.grant(c.req.param("id"))));

/** Learn a repo, into the project's own brain; the study chat is filed under the project. */
projectRoutes.post("/projects/:id/learn", async (c) => {
  const project = found(projects.get(c.req.param("id")));
  if (project.kind === "none") throw new HttpError(400, "There's no code to learn in this project.");
  const { agentId } = await body<{ agentId?: string }>(c).catch(() => ({ agentId: undefined }));
  const agent = found(agentId ? agents.get(agentId) : agents.first(), "Agent not found.");
  // A folder on this Mac is studied in place: it needs the user's OK and a local computer.
  if (project.kind === "folder") checkout.usableFolder(agent.id, project);
  const source = projects.learnSource(project);
  if (!source) throw new HttpError(400, "This project's files can't be learned yet.");
  const started = await learnRepo(agent.id, source, { projectId: project.id });
  const chat = conversations.get(started.conversationId);
  if (chat) appEvents.publish({ type: "conversation", conversation: toPublicConversation(chat) });
  return c.json({ conversationId: started.conversationId, runId: started.runId });
});
