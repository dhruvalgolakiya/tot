import { brains, cloneFolder, githubFullName } from "../data/brains.ts";
import { taskTitle } from "./tasks.ts";

/**
 * Which requests from Slack and email become tasks rather than chats: a plain, explicit rule
 * until a smarter dispatcher replaces it (roadmap module 02). A request is work when it starts
 * with a work verb ("fix…", "investigate…", "research…") and either names a repo the agent
 * knows (a repo brain, a GitHub URL) or is clearly a job on its own ("fix", "investigate"…).
 */

const WORK = /^(?:(?:hey|hi|ok|okay)[,!]?\s+)?(?:(?:can|could|would) you\s+|please\s+)?(fix|investigate|debug|implement|build|refactor|migrate|upgrade|add|update|write|research|compare|look into|find out|figure out|set up|review|audit|clean up)\b/i;
/** Verbs that mean a job even without a repo. */
const JOB = new Set(["fix", "investigate", "debug", "implement", "refactor", "migrate", "research", "compare", "audit"]);

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

/** The task a request should become, or null for a normal chat. */
export function workRequest(agentId: string, text: string): { title: string; goal: string; repo?: string } | null {
  const request = text.trim();
  const verb = WORK.exec(request)?.[1]?.toLowerCase();
  if (!verb) return null;
  const repo = repoMentioned(agentId, request);
  if (!repo && !JOB.has(verb)) return null;
  return { title: taskTitle(request), goal: request, ...(repo ? { repo } : {}) };
}
