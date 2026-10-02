import { appEvents } from "../app-events.ts";
import { agents } from "../data/agents.ts";
import { conversations } from "../data/conversations.ts";
import { settings } from "../data/settings.ts";
import { HttpError, sendMessage } from "./orchestrator.ts";

/**
 * "Learn a repo": a chat in which the agent clones a codebase onto its
 * computer, studies it, and writes it up in its workspace wiki (DeepWiki-style),
 * so later chats — e.g. one per ticket — start out knowing the code.
 */

/** "https://github.com/acme/web.git" → "web"; "~/repos/api/" → "api". Safe as a folder name. */
export function repoName(source: string): string {
  const last = source.replace(/[/\\]+$/, "").split(/[/:\\]/).pop() ?? "";
  return last.replace(/\.git$/i, "").replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[.-]+/, "") || "repo";
}

export function validateRepoSource(source: unknown): string {
  const text = typeof source === "string" ? source.trim() : "";
  if (!text) throw new HttpError(400, "Enter a git URL or a folder on the agent's computer.");
  if (text.length > 500 || /[\r\n]/.test(text)) throw new HttpError(400, "That doesn't look like a repo URL or folder.");
  // Credentials belong in Settings → Connections, not in a URL that ends up in chats and the wiki.
  if (/^[a-z][a-z0-9+.-]*:\/\/(?!git@)[^/@\s]+@/i.test(text)) {
    throw new HttpError(400, "Leave the login out of the URL. Connect GitHub in Settings → Connections instead.");
  }
  return text;
}

function instructions(source: string, name: string): string {
  return `[Learn a codebase into your wiki. The user wants you to study the repository below and write it up in your workspace wiki, so you — and every future chat in this workspace, e.g. one per ticket — can work on it without re-reading the code.

Repository: ${source}

1. Get the code onto your computer: clone it into ~/repos/${name} (if it's already there, pull the latest; if it's a folder already on your computer, use it in place). If cloning fails because it's private, stop and tell the user to connect GitHub in Settings → Connections (or, if it's connected, that this account can't see the repo).
2. Note the commit you're studying (git log -1 --format='%h %s (%cs)').
3. Study it: README and docs, AGENTS.md / CLAUDE.md / .cursorrules / CONTRIBUTING, package manifests, entry points, the main modules, tests, CI and deploy config. Skim; don't read every file.
4. Write the wiki with wiki_write, all nested under one page named “${name}”:
   - “${name}”: what it is, the stack, where it lives on your computer, the commit you studied, and a map of its sub-pages.
   - “Architecture”: the main parts and how they connect, with a \`\`\`mermaid diagram.
   - One page per major area or module (up to about 8): key files (paths), responsibilities, how data flows, how to change it safely.
   - “Run, test & deploy”: exact commands, environment variables (names only, never values), CI.
   - “Conventions & gotchas”: code style, patterns to follow, pitfalls.
   If the wiki already has pages for this repo, update them instead of duplicating.
5. Add the repo to the Overview page: one line on what it is and where it lives on your computer.
6. Finish with a short summary of the pages you wrote.
Cite file paths, keep pages scannable, don't paste large code, and never copy secrets into the wiki.]`;
}

export async function learnRepo(agentId: string, source: string): Promise<{ conversationId: string; runId: string }> {
  const agent = agents.get(agentId);
  if (!agent) throw new HttpError(404, "Agent not found.");
  if (settings.get().computer.mode === "off") {
    throw new HttpError(400, `${agent.name} needs a computer to study code. Turn one on in Settings → Computer.`);
  }
  if (!settings.get().memory.enabled) throw new HttpError(400, "The wiki is off. Turn on Memory in Settings → General.");
  const name = repoName(source);
  const conversation = conversations.create({ agentId: agent.id, modelId: agent.modelId, title: `Learn ${name}` });
  appEvents.agentChanged(agent.id);
  const { runId } = await sendMessage(
    conversation.id,
    { text: `Learn ${source} and write it up in the wiki.` },
    { preamble: instructions(source, name), keepTitle: true, heavy: "studying a codebase" },
  );
  return { conversationId: conversation.id, runId };
}
