import { personas } from "../data/personas.ts";
import { github } from "../github.ts";
import { githubAuthor, quote } from "./github-login.ts";
import type { ComputerBackend } from "./types.ts";

/**
 * While an agent works as a persona, commits on its computer are authored as the persona (its
 * name and mailbox address). This runs after the GitHub login step, which makes the GitHub
 * account the author, so the persona wins; once the persona is removed, the GitHub author comes
 * back (or none, without GitHub). `tot.persona` in git's config marks an author set here.
 */

/** Re-apply now and then even when nothing changed, undoing edits made on the computer. */
const RESYNC_MS = 10 * 60_000;

const synced = new Map<string, { fingerprint: string; at: number }>();

function restoreScript(): string {
  const who = github.identity();
  const author = who ? githubAuthor(who) : null;
  return [
    "if git config --global tot.persona >/dev/null; then",
    "  git config --global --unset tot.persona",
    ...(author
      ? [`  git config --global user.name ${quote(author.name)}`, `  git config --global user.email ${quote(author.email)}`]
      : ["  git config --global --unset user.name || true", "  git config --global --unset user.email || true"]),
    "fi",
    "true",
  ].join("\n");
}

/** Brings one computer's git author in line with the agent's persona; a no-op when nothing changed recently. */
export async function syncPersonaIdentity(
  agentId: string,
  computer: { backend: ComputerBackend; externalId: string; event?: "created" | "resumed" },
): Promise<void> {
  const persona = personas.forAgent(agentId);
  // The GitHub step rewrites the author when its account changes, so its state is part of this one's.
  const fingerprint = JSON.stringify([persona?.id ?? null, persona?.name, persona?.email, github.fingerprint()]);
  const last = synced.get(computer.externalId);
  if (!computer.event && last?.fingerprint === fingerprint && Date.now() - last.at < RESYNC_MS) return;
  const script = persona
    ? [
        `git config --global user.name ${quote(persona.name)}`,
        `git config --global user.email ${quote(persona.email)}`,
        `git config --global tot.persona ${quote(persona.id)}`,
      ].join(" && ")
    : restoreScript();
  const result = await computer.backend.exec(computer.externalId, script, { timeoutMs: 30_000 });
  if (result.exitCode !== 0) throw new Error(`Couldn't set the computer's git author: ${result.stderr.trim().slice(0, 300)}`);
  synced.set(computer.externalId, { fingerprint, at: Date.now() });
}

/** Forget a computer (destroyed), so a new one with the same id gets synced. */
export function forgetPersonaIdentity(externalId: string): void {
  synced.delete(externalId);
}
