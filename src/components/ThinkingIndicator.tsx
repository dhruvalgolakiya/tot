import type { Message } from "@shared/types";
import { statusLabel } from "../lib/mascotState";

interface ThinkingIndicatorProps {
  agentName: string;
  message?: Message;
  live?: boolean;
}

/**
 * Quiet, shimmering status line shown while a reply is in progress but
 * nothing is actively rendering yet — before the first token, or between a
 * finished tool call and the next part.
 */
export function ThinkingIndicator({ agentName, message, live = false }: ThinkingIndicatorProps) {
  return (
    <div className="flex h-7 items-center" role="status">
      <span className="shimmer-text text-chat font-medium">{statusLabel(agentName, message, live)}</span>
    </div>
  );
}
