import { appEvents } from "../app-events.ts";
import { afterChange } from "../memory/memory.ts";
import { hideSecrets, scrub, secretKind } from "../trust/secrets.ts";
import { linked } from "./store.ts";

/**
 * Module 11, lane B: gives the wiki's store (store.ts) what it can't import itself — the secret checks, app events
 * and memory's after-a-change step all lead to data/agents.ts, which uses the wiki while it loads. Loaded by
 * knowledge/index.ts, memory/start.ts, and by data/wiki.ts once it has loaded.
 */
Object.assign(linked, {
  secretKind,
  scrub,
  hideSecrets,
  brainChanged: (brainId: string, structure: boolean) => appEvents.brainChanged(brainId, { structure }),
  announce: (repo: string, sha: string | null) => {
    // A project's repo also holds its memory: rebuild that index and tell its screens; another brain's repo only
    // needs the event.
    if (repo.startsWith("projects/")) afterChange(repo, sha);
    else appEvents.publish({ type: "memory", repo, sha });
  },
  ready: true,
});
