import { Hono, type Context } from "hono";
import type { MemoryDreamRequest, MemoryRepoSummary, SettingsPatch } from "@tot/shared/types";
import { HttpError } from "../agent/orchestrator.ts";
import { callerOf } from "../auth.ts";
import { memories } from "../data/memories.ts";
import { settings } from "../data/settings.ts";
import { projects } from "../projects/projects.ts";
import { tildePath } from "../projects/folders.ts";
import { dreaming, dreamState, dreamUndone } from "./dreaming.ts";
import { importDone, legacyMemories } from "./legacy.ts";
import { edit, ensureRepo, forget, history, readMemoryFile, remember, repoFiles, resolveRepo, undo } from "./memory.ts";
import { dropSkipped, importSkipped, importStatus } from "./migrate.ts";
import { listFiles, projectRepoId, repoDir, repoExists, safePath, YOU } from "./repo.ts";
import { createBundle, memorySync, remoteUrlProblem, syncNow, syncStatus } from "./sync.ts";

/**
 * Memory repo routes (roadmap module 10); docs in packages/shared/types.ts. `/api/memories` keeps working (the "you" repo,
 * or `?repo=`; until the one-time import lands, the old memories too, read-only). Paired devices may call none of
 * these (routes.ts) except the sync bundle, which only they may.
 */
export const memoryRoutes = new Hono();

async function body<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HttpError(400, "Expected a JSON body.");
  }
}

/** The repo named in the path (URL-encoded "projects%2Fweb", or a project's slug or id). */
const repoParam = (c: Context) => resolveRepo(c.req.param("repo"));

// The bundle a paired device fetches to sync "you": devices only, never a browser or a script.
memoryRoutes.get("/memory/sync/you.bundle", async (c) => {
  if (callerOf(c).kind !== "device") return c.json({ error: "Only a paired device can fetch this memory." }, 403);
  const bundle = await createBundle();
  return c.body(new Uint8Array(bundle), 200, { "content-type": "application/octet-stream", "cache-control": "no-store" });
});

memoryRoutes.get("/memory/repos", async (c) => {
  // A repo git can't make (the import's error says why) still lists, so Settings → Memory can show it.
  await ensureRepo(YOU).catch(() => {});
  const repos = [
    { id: YOU, kind: "you" as const, name: "About you", projectId: null },
    ...projects.list().map((project) => ({ id: projectRepoId(project.slug), kind: "project" as const, name: project.name, projectId: project.id })),
  ];
  const summaries: MemoryRepoSummary[] = await Promise.all(
    repos.map(async (repo) => ({
      ...repo,
      path: tildePath(repoDir(repo.id)),
      entries: memories.count(repo.id),
      files: repoExists(repo.id) ? listFiles(repo.id).length : 0,
      lastCommit: (await history(repo.id, 1))[0] ?? null,
      dream: dreamState(repo.id),
      sync: repo.id === YOU ? syncStatus() : null,
      import: repo.id === YOU ? importStatus() : null,
    })),
  );
  return c.json(summaries);
});

memoryRoutes.post("/memory/dream", async (c) => {
  const request = await body<MemoryDreamRequest>(c).catch(() => ({}) as MemoryDreamRequest);
  dreaming.now(request.repo ? resolveRepo(request.repo) : undefined);
  return c.json({ ok: true }, 202);
});

memoryRoutes.post("/memory/sync", async (c) => c.json(await syncNow()));

// Old memories the import left out as secrets: import one anyway, or drop it.
memoryRoutes.post("/memory/import/:id", async (c) => c.json(await importSkipped(c.req.param("id")), 201));

memoryRoutes.delete("/memory/import/:id", (c) => {
  dropSkipped(c.req.param("id"));
  return c.json({ ok: true });
});

memoryRoutes.get("/memory/:repo/files", (c) => c.json(repoFiles(repoParam(c))));

memoryRoutes.get("/memory/:repo/file", (c) => {
  const repo = repoParam(c);
  const file = readMemoryFile(repo, safePath(c.req.query("path") ?? ""));
  if (!file) throw new HttpError(404, "That file isn't in this memory.");
  return c.json(file);
});

memoryRoutes.get("/memory/:repo/history", async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 30, 1), 200);
  const skip = Math.max(Number(c.req.query("skip")) || 0, 0);
  return c.json(await history(repoParam(c), limit, skip));
});

memoryRoutes.post("/memory/:repo/revert", async (c) => {
  const { sha } = await body<{ sha?: string }>(c);
  if (typeof sha !== "string" || !sha) throw new HttpError(400, "Say which change to undo: { sha }.");
  const repo = repoParam(c);
  const made = await undo(repo, sha.trim());
  dreamUndone(repo, sha.trim());
  return c.json(made);
});

// --- /api/memories: entries, as before (now in a repo) ----------------------------------------------------------

memoryRoutes.get("/memories", (c) => {
  const repo = resolveRepo(c.req.query("repo"));
  const q = c.req.query("q")?.trim();
  const found = q ? memories.search(q, { repos: [repo], limit: 100 }) : memories.list(repo);
  if (repo !== YOU || importDone()) return c.json(found);
  // The import hasn't landed: the old memories still count, read-only.
  const words = (q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const known = new Set(found.map((memory) => memory.content.toLowerCase()));
  const legacy = legacyMemories().filter((memory) => !known.has(memory.content.toLowerCase()) && (!words.length || words.some((word) => memory.content.toLowerCase().includes(word))));
  return c.json([...found, ...legacy]);
});

memoryRoutes.post("/memories", async (c) => {
  const input = await body<{ content?: string; repo?: string; file?: string }>(c);
  if (!input.content?.trim()) throw new HttpError(400, "Memory can't be empty.");
  const repo = resolveRepo(input.repo);
  const { memory, duplicate } = await remember({ repo, text: input.content, file: input.file, source: "you", actor: "you" });
  return c.json(memory, duplicate ? 200 : 201);
});

memoryRoutes.patch("/memories/:id", async (c) => {
  const { content, expected } = await body<{ content?: string; expected?: string }>(c);
  if (!content?.trim()) throw new HttpError(400, "Memory can't be empty.");
  if (expected !== undefined && typeof expected !== "string") throw new HttpError(400, "`expected` is the text the edit started from.");
  return c.json(await edit({ repos: [resolveRepo(c.req.query("repo"))], id: c.req.param("id"), text: content, actor: "you", expected }));
});

memoryRoutes.delete("/memories/:id", async (c) => {
  await forget({ repos: [resolveRepo(c.req.query("repo"))], id: c.req.param("id"), actor: "you" });
  return c.json({ ok: true });
});

// --- Settings ---------------------------------------------------------------------------------------------------

/** Checks the memory part of PATCH /api/settings (Dreaming's time, the backup remote's URL). */
export function checkMemorySettings(patch: SettingsPatch["memory"]): void {
  if (!patch) return;
  const time = patch.dreaming?.time;
  if (time !== undefined && (typeof time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))) {
    throw new HttpError(400, 'Dreaming\'s time is a 24-hour "HH:MM", e.g. "03:30".');
  }
  const url = patch.remote?.url;
  if (url !== undefined) {
    if (typeof url !== "string") throw new HttpError(400, "The backup remote's URL must be text.");
    const problem = remoteUrlProblem(url);
    if (problem) throw new HttpError(400, problem);
    patch.remote!.url = url.trim();
  }
  if (patch.remote?.enabled === true && !(patch.remote.url ?? settings.get().memory.remote.url).trim()) {
    throw new HttpError(400, "Set the backup remote's URL first.");
  }
}

/** After PATCH /api/settings: a newly set backup remote is tried soon. */
export function memorySettingsChanged(patch: SettingsPatch["memory"]): void {
  if (patch?.remote) memorySync.settingsChanged();
}
