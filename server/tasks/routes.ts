import { Hono, type Context } from "hono";
import type { ConvertToTaskRequest, StartTaskRequest, SteerRequest, TaskPatch, TaskStatus } from "../../shared/types.ts";
import { HttpError } from "../agent/orchestrator.ts";
import { agents } from "../data/agents.ts";
import { conversations } from "../data/conversations.ts";
import { steer } from "./steer.ts";
import { isTask, taskStore, toPublic, type TaskRecord } from "./store.ts";
import { tasks } from "./tasks.ts";

/** Task routes, mounted on /api (see the route docs in shared/types.ts). */
export const taskRoutes = new Hono();

async function body<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HttpError(400, "Expected a JSON body.");
  }
}

const STATUSES = new Set<TaskStatus>(["queued", "running", "needs-input", "paused", "done", "failed", "stopped", "interrupted"]);

/** Queued tasks in queue order first, then the rest newest first. */
function ordered(list: TaskRecord[]): TaskRecord[] {
  const queued = list
    .filter((task) => task.task.status === "queued")
    .sort((a, b) => (a.task.queuePosition ?? 0) - (b.task.queuePosition ?? 0) || a.createdAt - b.createdAt);
  const rest = list.filter((task) => task.task.status !== "queued").sort((a, b) => b.updatedAt - a.updatedAt);
  return [...queued, ...rest];
}

taskRoutes.get("/tasks", (c) => {
  const agentId = c.req.query("agentId") || undefined;
  const status = c.req.query("status") as TaskStatus | undefined;
  if (status && !STATUSES.has(status)) throw new HttpError(400, "Unknown status.");
  const list = conversations.tasks({ agentId }).filter(isTask).filter((task) => !status || task.task.status === status);
  return c.json(ordered(list).map(toPublic));
});

taskRoutes.post("/tasks", async (c) => {
  const request = await body<StartTaskRequest & { agentId?: string }>(c);
  const agent = request.agentId ? agents.get(request.agentId) : agents.first();
  if (!agent) throw new HttpError(404, "Agent not found.");
  return c.json(toPublic(tasks.create({ ...request, agentId: agent.id })), 201);
});

taskRoutes.post("/conversations/:id/tasks", async (c) => {
  const request = await body<StartTaskRequest>(c);
  return c.json(toPublic(tasks.startFromChat(c.req.param("id"), request, "user")), 201);
});

taskRoutes.post("/conversations/:id/convert", async (c) => {
  const request = await body<ConvertToTaskRequest>(c).catch(() => ({}) as ConvertToTaskRequest);
  return c.json(toPublic(tasks.convert(c.req.param("id"), request)));
});

taskRoutes.post("/conversations/:id/steer", async (c) => {
  const { text } = await body<Partial<SteerRequest>>(c);
  if (typeof text !== "string") throw new HttpError(400, "Expected { text }.");
  return c.json(steer(c.req.param("id"), text));
});

taskRoutes.post("/tasks/:id/pause", (c) => c.json(toPublic(tasks.pause(c.req.param("id")))));
taskRoutes.post("/tasks/:id/resume", (c) => c.json(toPublic(tasks.resume(c.req.param("id")))));
taskRoutes.post("/tasks/:id/stop", (c) => c.json(toPublic(tasks.stop(c.req.param("id")))));
taskRoutes.post("/tasks/:id/run-now", (c) => c.json(toPublic(tasks.runNow(c.req.param("id")))));

taskRoutes.post("/tasks/:id/to-chat", (c) => {
  tasks.toChat(c.req.param("id"));
  return c.json({ ok: true });
});

taskRoutes.patch("/tasks/:id", async (c) => {
  const patch = await body<TaskPatch>(c);
  return c.json(toPublic(tasks.patch(c.req.param("id"), patch)));
});

taskRoutes.get("/tasks/:id/changes", async (c) => {
  taskStore.require(c.req.param("id"));
  return c.json(await tasks.changes(c.req.param("id")));
});
