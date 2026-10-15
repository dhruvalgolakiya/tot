import { useSyncExternalStore } from "react";

// The Markdown renderer (react-markdown + highlight.js + KaTeX) is most of the
// bundle, so it lives in its own chunk. Call this early to warm it up.

type MarkdownModule = typeof import("../components/Markdown");

let loaded: MarkdownModule | null = null;
/** The chunk failed to load: render on anyway (LazyMarkdown's own fallback takes over). */
let failed = false;
let pending: Promise<MarkdownModule> | null = null;
const listeners = new Set<() => void>();

export function loadMarkdown(): Promise<MarkdownModule> {
  pending ??= import("../components/Markdown").then(
    (module) => {
      loaded = module;
      listeners.forEach((listener) => listener());
      return module;
    },
    (error: unknown) => {
      pending = null;
      failed = true;
      listeners.forEach((listener) => listener());
      throw error;
    },
  );
  return pending;
}

/** The renderer once its chunk is here, so markdown renders right away instead of suspending; null until then. */
export const loadedMarkdown = (): MarkdownModule | null => loaded;

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Whether the renderer chunk has arrived (or failed). A chat waits for it behind its loading skeleton, so its
 * messages render once, as markdown, rather than as plain text first and markdown a moment later.
 */
export function useMarkdownReady(): boolean {
  return useSyncExternalStore(subscribe, () => loaded !== null || failed);
}
