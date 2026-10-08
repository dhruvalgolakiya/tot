// Agent identity (the crew page): the island each agent works from and its tagline — the migration that adds
// them to an existing database, the round-robin island default, editing both, and validation.
// Run: TOT_DATA_DIR=$(mktemp -d) npx tsx server/agents.test.ts
import "./test-data-dir.ts"; // first: refuses to run against the real ~/.tot
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Agent } from "../shared/types.ts";

process.env.TOT_ACCESS_TOKEN = ""; // empty overrides .env: no sign-in for this test

// A database from before islands and taglines: the agents table as it was first made, with two agents in it.
const DATA_DIR = process.env.TOT_DATA_DIR!;
mkdirSync(DATA_DIR, { recursive: true });
const old = new DatabaseSync(join(DATA_DIR, "tot.db"));
old.exec(`
  CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    mascot TEXT NOT NULL,
    instructions TEXT NOT NULL DEFAULT '',
    model_id TEXT NOT NULL DEFAULT 'auto',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
`);
const mascot = JSON.stringify({ shape: "blob", color: "#8b7cf6", accessory: "none", eyes: "dots" });
old.prepare(`INSERT INTO agents (id, name, mascot, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`).run("old-1", "Tot", mascot, 1000, 1000);
old.prepare(`INSERT INTO agents (id, name, mascot, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`).run("old-2", "Bolt", mascot, 2000, 2000);
old.close();

const { db } = await import("./db.ts");
const { agents, validateAgent } = await import("./data/agents.ts");
const { createApp } = await import("./app.ts");

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

const columns = (db.prepare(`PRAGMA table_info(agents)`).all() as { name: string; notnull: number }[]).filter(
  (c) => c.name === "island" || c.name === "tagline",
);
check("migration adds island and tagline", columns.length === 2, JSON.stringify(columns));
check("both columns are nullable", columns.every((c) => c.notnull === 0));
const legacy = db.prepare(`SELECT island, tagline FROM agents WHERE id = 'old-1'`).get() as { island: unknown; tagline: unknown };
check("existing agents keep null island and tagline", legacy.island === null && legacy.tagline === null);

// Existing agents get islands round-robin by creation order, and no tagline.
const [tot, bolt] = agents.list();
check("first agent: the workshop", tot?.island === "workshop", tot?.island);
check("second agent: the observatory", bolt?.island === "observatory", bolt?.island);
check("no tagline by default", tot?.tagline === "" && bolt?.tagline === "");
check("get() agrees with list()", agents.get("old-2")?.island === "observatory");

// New agents continue the rotation and keep their island.
const nimbus = agents.create({ name: "Nimbus", mascot: JSON.parse(mascot) });
const mochi = agents.create({ name: "Mochi", mascot: JSON.parse(mascot) });
const fifth = agents.create({ name: "Fifth", mascot: JSON.parse(mascot) });
check("third agent: the signal tower", nimbus.island === "tower", nimbus.island);
check("fourth agent: the greenhouse", mochi.island === "greenhouse", mochi.island);
check("fifth agent wraps around", fifth.island === "workshop", fifth.island);
const stored = db.prepare(`SELECT island FROM agents WHERE id = ?`).get(nimbus.id) as { island: string };
check("a new agent's island is stored", stored.island === "tower");
const picked = agents.create({ name: "Picked", mascot: JSON.parse(mascot), island: "greenhouse", tagline: "  the lab  " });
check("create takes an island and a trimmed tagline", picked.island === "greenhouse" && picked.tagline === "the lab");

// Editing.
const edited = agents.update(nimbus.id, { island: "observatory", tagline: "  the stargazer " });
check("update sets the island", edited?.island === "observatory");
check("update trims the tagline", edited?.tagline === "the stargazer");
check("an empty tagline clears it", agents.update(nimbus.id, { tagline: "   " })?.tagline === "");
const reset = agents.update("old-2", { island: "tower" }) && agents.update("old-2", { island: null });
check("island null goes back to the round-robin default", reset?.island === "observatory", reset?.island);

// Deleting an older agent doesn't move a newer one's island.
agents.delete("old-1");
check("stored islands survive deletes", agents.get(mochi.id)?.island === "greenhouse");

// Validation.
check("rejects an unknown island", validateAgent({ island: "volcano" as never }, false) !== null);
check("rejects a long tagline", validateAgent({ tagline: "x".repeat(41) }, false) !== null);
check("accepts a 40-character tagline", validateAgent({ tagline: "x".repeat(40) }, false) === null);
check("accepts island null", validateAgent({ island: null }, false) === null);

// The update route.
const app = createApp();
async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
  const res = await app.request(`http://localhost:8787/api${path}`, {
    method,
    headers: { Host: "localhost:8787", Origin: "http://localhost:8787", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, data: (await res.json()) as T };
}
const patched = await call<Agent>("PATCH", `/agents/${mochi.id}`, { island: "workshop", tagline: "the potting shed" });
check("PATCH /agents/:id saves island and tagline", patched.status === 200 && patched.data.island === "workshop" && patched.data.tagline === "the potting shed", JSON.stringify(patched.data).slice(0, 160));
const bad = await call<{ error: string }>("PATCH", `/agents/${mochi.id}`, { island: "volcano" });
check("PATCH rejects an unknown island", bad.status === 400);
const listed = await call<Agent[]>("GET", "/agents");
check("GET /agents includes island and tagline", listed.data.every((a) => typeof a.island === "string" && typeof a.tagline === "string"));

console.log(failures ? `\n${failures} FAILED` : "\nALL PASS");
process.exit(failures ? 1 : 0);
