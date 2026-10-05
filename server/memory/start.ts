import { dreaming } from "./dreaming.ts";
import { reindexAll } from "./index.ts";
import { migrateMemories } from "./migrate.ts";
import { recoverRepos } from "./repo.ts";
import { memorySync } from "./sync.ts";

const message = (err: unknown) => (err instanceof Error ? err.message : err);

/**
 * Memory at startup (roadmap module 10): put right what a crash left in the repos (a stale lock, a half-done
 * undo, this device's git settings), import the memories from before memory became a git repo (until it lands;
 * a failure shows in Settings → Memory and the old memories are read meanwhile), rebuild the index from the
 * files, then sync with paired devices and the backup remote, and dream nightly.
 */
export async function startMemory(): Promise<void> {
  try {
    for (const fixed of await recoverRepos()) console.warn(`[tot] memory: cleared ${fixed}`);
  } catch (err) {
    console.error("[tot] memory couldn't check its repos:", message(err));
  }
  try {
    const imported = await migrateMemories();
    if (imported) console.log(`Memory: imported ${imported} memories into a git repo.`);
  } catch (err) {
    console.error("[tot] memory couldn't import the old memories (it tries again at the next start):", message(err));
  }
  try {
    reindexAll();
  } catch (err) {
    console.error("[tot] memory couldn't rebuild its index:", message(err));
  }
  memorySync.start();
  dreaming.start();
}

export function stopMemory(): void {
  memorySync.stop();
  dreaming.stop();
}
