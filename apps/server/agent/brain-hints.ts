import { brains } from "../data/brains.ts";
import { settings } from "../data/settings.ts";
import { wiki } from "../data/wiki.ts";

/**
 * Signal-based routing to brains. When a request, a command or a path mentions a
 * brain the agent has (its repo, URL, ~/repos/<folder>, @name or a keyword), the
 * agent is shown that brain's Overview once per chat, and the first such brain
 * becomes the chat's focus (where new pages go by default). No model call: plain
 * matching is predictable and costs nothing when nothing matches.
 */

const OVERVIEW_CHARS = 3000;
/** At most this many new brains are introduced at once. */
const MAX_PER_HINT = 2;

/** A note introducing brains `text` is about that this chat hasn't been pointed at yet; "" when there are none. */
export function brainHints(agentId: string, conversationId: string, text: string): string {
  if (!settings.get().memory.enabled) return "";
  const seen = brains.hinted(conversationId);
  const fresh = brains
    .match(agentId, text)
    .filter((brain) => !seen.has(brain.id))
    .slice(0, MAX_PER_HINT);
  if (!fresh.length) return "";
  brains.markHinted(conversationId, fresh.map((brain) => brain.id));
  if (!brains.focus(conversationId)) brains.setFocus(conversationId, fresh[0].id);

  return fresh
    .map((brain) => {
      const overview = wiki.overview(brain.id).content.trim();
      const body =
        overview.length > OVERVIEW_CHARS ? `${overview.slice(0, OVERVIEW_CHARS)}\n… (truncated — wiki_read its Overview for the rest)` : overview;
      return `[This looks like work on “${brain.name}” — you have a brain for it${brain.access === "read" ? " (read-only)" : ""}. Read the pages that matter before you start (wiki_search with brain "${brain.name}" lists them), and put what you learn about it there.
Its Overview:
${body || "(empty so far)"}]`;
    })
    .join("\n\n");
}
