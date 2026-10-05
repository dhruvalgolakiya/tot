import { dreaming } from "./dreaming.ts";
import { reindexAll } from "./index.ts";
import { migrateMemories } from "./migrate.ts";
import { memorySync } from "./sync.ts";

/**
 * Memory at startup (roadmap module 10): import the memories from before memory became a git repo (once),
 * rebuild the index from the files, then sync with paired devices and the backup remote, and dream nightly.
 */
export async function startMemory(): Promise<void> {
  try {
    const imported = await migrateMemories();
    if (imported) console.log(`Memory: imported ${imported} memories into a git repo.`);
    reindexAll();
  } catch (err) {
    console.error("[tot] memory couldn't start:", err instanceof Error ? err.message : err);
  }
  memorySync.start();
  dreaming.start();
}

export function stopMemory(): void {
  memorySync.stop();
  dreaming.stop();
}
