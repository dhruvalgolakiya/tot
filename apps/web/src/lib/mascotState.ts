import type { Message, MascotState } from "@tot/shared/types";

/**
 * Derive a mascot's animation state from a message that is (or just was)
 * streaming. Everything here is computed client-side from data we already
 * have — there is no separate "mascot state" on the wire.
 */
export function messageMascotState(
  message: Message | undefined,
  { live, justFinished }: { live: boolean; justFinished: boolean },
): MascotState {
  if (message?.error) return "error";
  if (justFinished) return "happy";
  if (!message || !live || message.status !== "streaming") return "idle";

  const last = message.parts.at(-1);
  if (last?.type === "tool" && last.status === "running") return "working";
  if (last?.type === "text") return "speaking";
  // Reasoning, a just-finished tool, or a notice: composing the next part.
  return "thinking";
}

/**
 * The quiet, Grok-Bot-style status line shown while a reply is in progress
 * but nothing is actively rendering yet (before the first token, or between
 * a finished tool call and the next part).
 */
export function statusLabel(agentName: string, message: Message | undefined, live: boolean): string {
  const last = live ? message?.parts.at(-1) : undefined;
  if (last?.type === "tool") {
    if (last.name.startsWith("computer_")) return `${agentName} is using the computer…`;
    if (last.name.startsWith("web_")) return `${agentName} is searching the web…`;
    if (last.name.startsWith("memory_")) return `${agentName} is remembering…`;
    return `${agentName} is working…`;
  }
  return `${agentName} is thinking…`;
}
