import { useEffect } from "react";
import { selectActiveAgent, useStore } from "../store";

export const DEFAULT_ACCENT = "#a78bfa";

/**
 * Keeps the `--agent-accent` CSS variable (declared in index.css, with soft
 * color-mix() variants derived from it) in sync with the active agent's mascot
 * color. This is the only saturated color in the app: switching agents subtly
 * re-tints focus rings, the send button, the active agent pill, glows, the
 * Think-harder "on" state, links, and the "working" pulse.
 */
export function useAgentAccent(): void {
  const color = useStore((s) => selectActiveAgent(s)?.mascot.color) ?? DEFAULT_ACCENT;

  useEffect(() => {
    document.documentElement.style.setProperty("--agent-accent", color);
  }, [color]);
}
