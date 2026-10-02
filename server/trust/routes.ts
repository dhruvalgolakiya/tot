import { Hono, type Context } from "hono";
import type { RepoProfileInput } from "../../shared/types.ts";
import { HttpError } from "../agent/orchestrator.ts";
import { draftProfile, repoProfiles, runProfileCommand } from "./profile.ts";

/** Trust gates & playbooks (module 03). Mounted under /api; errors reach the API's own handler. */
export const trustRoutes = new Hono();

async function body<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HttpError(400, "Expected a JSON body.");
  }
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
