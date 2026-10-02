import { brains, cloneFolder, githubFullName } from "../data/brains.ts";

/**
 * Which repo a request is about. Module 01 used this with a keyword rule to turn Slack and
 * email requests into tasks; the dispatcher (orchestration/dispatch.ts) does that now, and
 * uses this to pick the repo for coding work.
 */

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A repo the text is about: one of the agent's repo brains (by name, owner/name, URL or folder), or a GitHub URL. */
export function repoMentioned(agentId: string, text: string): string | undefined {
  const matched = brains.match(agentId, text).find((brain) => brain.kind === "repo" && brain.source);
  if (matched?.source) return matched.source;
  for (const brain of brains.forAgent(agentId)) {
    if (brain.kind !== "repo" || !brain.source) continue;
    const names = [githubFullName(brain.source), cloneFolder(brain.source), brain.name].filter((name): name is string => Boolean(name));
    if (names.some((name) => new RegExp(`(?:^|[^\\w./-])${escape(name)}(?![\\w-])`, "i").test(text))) return brain.source;
  }
  return /https?:\/\/github\.com\/[\w.-]+\/[\w.-]+/i.exec(text)?.[0]?.replace(/[.,)]+$/, "");
}
