import { Hono, type Context } from "hono";
import type { GateName, RepoProfileInput, TrustCheckRequest } from "../../shared/types.ts";
import { HttpError } from "../agent/orchestrator.ts";
import { IS_PROD } from "../config.ts";
import { agents } from "../data/agents.ts";
import { COMMAND_GATES, runGates } from "./gates.ts";
import { draftProfile, profileForFolder, repoProfiles, runProfileCommand } from "./profile.ts";
import { planFrom } from "./scope.ts";

/** Trust gates & playbooks (module 03). Mounted under /api; errors reach the API's own handler. */
export const trustRoutes = new Hono();

async function body<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HttpError(400, "Expected a JSON body.");
  }
}

const GATES: GateName[] = [...COMMAND_GATES, "repro", "scope", "deps", "size", "review"];

/** The agent and repo folder a dev check runs against. */
function target(input: { agentId?: unknown; cwd?: unknown; baseRef?: unknown }): { agentId: string; cwd: string; baseRef: string } {
  if (typeof input.agentId !== "string" || !agents.get(input.agentId)) throw new HttpError(404, "Agent not found.");
  if (typeof input.cwd !== "string" || !input.cwd.trim()) throw new HttpError(400, "Give the repo's folder on the agent's computer, e.g. repos/web.");
  if (typeof input.baseRef !== "string" || !input.baseRef.trim()) throw new HttpError(400, "Give the base branch to compare with, e.g. main.");
  return { agentId: input.agentId, cwd: input.cwd.trim(), baseRef: input.baseRef.trim() };
}

// --- Repo profiles ---------------------------------------------------------

trustRoutes.get("/brains/:id/profile", (c) => c.json(repoProfiles.get(c.req.param("id"))));

trustRoutes.put("/brains/:id/profile", async (c) => c.json(repoProfiles.save(c.req.param("id"), await body<RepoProfileInput>(c), "user")));

trustRoutes.post("/brains/:id/profile/draft", async (c) => {
  const { agentId } = await body<{ agentId?: string }>(c);
  return c.json(await draftProfile(c.req.param("id"), agentId));
});

trustRoutes.post("/brains/:id/profile/run", async (c) => {
  const { agentId, command } = await body<{ agentId?: string; command: string }>(c);
  return c.json(await runProfileCommand(c.req.param("id"), command, agentId));
});

// --- Dev only until tasks exist: exercise the services on any repo folder ---

if (!IS_PROD) {
  trustRoutes.post("/trust/check", async (c) => {
    const input = await body<TrustCheckRequest>(c);
    const { agentId, cwd, baseRef } = target(input);
    if (input.gates !== undefined && (!Array.isArray(input.gates) || input.gates.some((gate) => !GATES.includes(gate)))) {
      throw new HttpError(400, `Gates are some of: ${GATES.join(", ")}.`);
    }
    const { brainId, profile } = await profileForFolder(agentId, cwd);
    const gates = input.gates ?? [...COMMAND_GATES.filter((gate) => profile.commands[gate]), "scope", "deps", "size"];
    return c.json(await runGates({ agentId, cwd, baseRef, profile, brainId, gates, plan: input.plan?.trim() ? planFrom(input.plan) : undefined }));
  });
}
