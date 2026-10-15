/**
 * Run `callback` when the browser is idle (within `timeout` ms at the latest); returns a cancel function.
 * Safari has no requestIdleCallback, so there it's a short timeout.
 */
export function whenIdle(callback: () => void, timeout = 500): () => void {
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(callback, { timeout });
    return () => window.cancelIdleCallback(id);
  }
  const id = window.setTimeout(callback, 50);
  return () => window.clearTimeout(id);
}
