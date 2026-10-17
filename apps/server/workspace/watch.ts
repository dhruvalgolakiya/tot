import { watch, type FSWatcher } from "node:fs";

/**
 * Tells open panels when files in a chat's folder change (the agent's edits, a terminal, the user's editor), so
 * the Diff and Files tabs refresh without being asked. One watcher per folder, shared by every panel showing it,
 * closed when the last one goes. Bursts (a checkout, an install) come out as one change.
 */

const DEBOUNCE_MS = 300;
/** Busy folders whose churn says nothing about the user's changes. git's index and HEAD still count. */
const NOISE = /(^|\/)(node_modules|\.next|\.turbo|\.cache|\.DS_Store)(\/|$)|^\.git\/(objects|logs|lfs)\//;

interface Watched {
  watcher: FSWatcher | null;
  listeners: Set<() => void>;
  timer: NodeJS.Timeout | null;
}

const folders = new Map<string, Watched>();

function fire(entry: Watched): void {
  entry.timer = null;
  for (const listener of [...entry.listeners]) listener();
}

export const workspaceWatch = {
  /** Calls `onChange` after files in `root` change, until the returned function is called. */
  subscribe(root: string, onChange: () => void): () => void {
    let entry = folders.get(root);
    if (!entry) {
      const created: Watched = { watcher: null, listeners: new Set(), timer: null };
      try {
        created.watcher = watch(root, { recursive: true }, (_event, name) => {
          if (name && NOISE.test(String(name))) return;
          if (!created.timer) created.timer = setTimeout(() => fire(created), DEBOUNCE_MS);
        });
        created.watcher.on("error", () => {
          created.watcher?.close();
          created.watcher = null;
        });
      } catch {
        // Can't watch it (gone, or too many files for this system): panels still refresh on focus and after turns.
      }
      entry = created;
      folders.set(root, entry);
    }
    const watched = entry;
    watched.listeners.add(onChange);
    return () => {
      watched.listeners.delete(onChange);
      if (watched.listeners.size || folders.get(root) !== watched) return;
      folders.delete(root);
      if (watched.timer) clearTimeout(watched.timer);
      watched.watcher?.close();
    };
  },

  /** Open watchers, for tests. */
  count: () => folders.size,
};
