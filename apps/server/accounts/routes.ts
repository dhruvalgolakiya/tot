import { Hono, type Context } from "hono";
import type { AccountInput, AccountLogin, AccountPatch } from "@tot/shared/types";
import { HttpError } from "../agent/orchestrator.ts";
import { loginCommand } from "../agent/providers/claude.ts";
import { accountStatuses, providerFor } from "../agent/providers/index.ts";
import { straightFromThisMachine } from "../auth.ts";
import { pickFolderOnThisMac } from "../projects/folders.ts";
import { AccountError, accounts } from "./accounts.ts";
import { t3Import } from "./t3.ts";

/** Provider accounts. Route docs: packages/shared/types.ts. Answers carry env key names at most, never their values. */
export const accountRoutes = new Hono();

accountRoutes.onError((err, c) => {
  if (err instanceof AccountError || err instanceof HttpError) return c.json({ error: err.message }, err.status);
  console.error("[tot] account request failed:", err);
  return c.json({ error: err.message || "Something went wrong." }, 500);
});

async function body<T>(c: Context): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HttpError(400, "Expected a JSON body.");
  }
}

accountRoutes.get("/accounts", async (c) => c.json(await accountStatuses(c.req.query("refresh") === "1")));

accountRoutes.post("/accounts", async (c) => c.json(accounts.add(await body<AccountInput>(c))));

accountRoutes.patch("/accounts/:id", async (c) => c.json(accounts.update(c.req.param("id"), await body<AccountPatch>(c))));

accountRoutes.delete("/accounts/:id", (c) => {
  accounts.remove(c.req.param("id"));
  return c.json({ ok: true });
});

/** ChatGPT: the sign-in page to open (Codex hosts the callback). Claude: the command that signs its folder in. */
accountRoutes.post("/accounts/:id/login", async (c) => {
  const account = accounts.require(c.req.param("id"));
  if (account.driver === "claude") return c.json({ kind: "command", command: loginCommand(account) } satisfies AccountLogin);
  const provider = providerFor(account.id);
  if (!provider.login) throw new HttpError(400, `${account.name} signs in through its own CLI.`);
  const { url } = await provider.login();
  return c.json({ kind: "url", url } satisfies AccountLogin);
});

/** macOS's folder picker, on this Mac: { path } (null when cancelled). */
accountRoutes.post("/accounts/folders/pick", async (c) => {
  if (!straightFromThisMachine(c)) throw new HttpError(403, "The folder picker opens on the Mac itself. Type the folder's path instead.");
  try {
    return c.json({ path: await pickFolderOnThisMac() });
  } catch (err) {
    throw new HttpError(409, err instanceof Error ? err.message : String(err));
  }
});

accountRoutes.get("/accounts/import/t3", (c) => c.json(t3Import.candidates()));

accountRoutes.post("/accounts/import/t3", async (c) => {
  const { ids } = await body<{ ids?: unknown }>(c);
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) throw new HttpError(400, "Pick the accounts to import.");
  return c.json(t3Import.run(ids));
});
