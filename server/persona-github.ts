import { createHash } from "node:crypto";
import type { Persona } from "../shared/types.ts";
import { appEvents } from "./app-events.ts";
import { getSecret, setSecret } from "./config.ts";
import { personas } from "./data/personas.ts";
import { github, GitHubError, lookUpAccount, tokenAccepted, type GitHubIdentity } from "./github.ts";

/**
 * Personas' own GitHub accounts, and which account each agent uses. A persona's token lives in
 * secrets.json (never sent back); its profile and writes switch are stored with the persona. An
 * agent working as a persona with an account uses that account everywhere (GitHub tools, git and
 * gh on its computer, its prompt); any other agent uses the app-wide connection, as the user.
 */

const VALIDATE_EVERY_MS = 10 * 60_000;

const secretName = (personaId: string) => `personaGitHubToken:${personaId}` as const;

/** When each persona's token was last checked with GitHub. */
const checked = new Map<string, number>();

/** The GitHub account an agent uses, with its token. */
export interface AgentGitHub extends GitHubIdentity {
  /** Its persona's own account, or the user's app-wide connection. */
  source: "persona" | "user";
}

/** Which GitHub account an agent uses: its persona's own when connected, else the user's; null without either. */
export function githubAccessFor(agentId: string): AgentGitHub | null {
  const personaId = personas.idForAgent(agentId);
  const account = personaId ? personas.githubAccount(personaId) : null;
  const token = personaId && account ? getSecret(secretName(personaId)) : undefined;
  if (account && token) {
    return { token, login: account.login, name: account.name, id: account.id, allowWrites: account.allowWrites, source: "persona" };
  }
  const who = github.identity();
  return who ? { ...who, source: "user" } : null;
}

/** Changes whenever what the agent's computer should hold for GitHub changes. */
export function githubFingerprintFor(agentId: string): string {
  const access = githubAccessFor(agentId);
  if (!access) return "none";
  return createHash("sha256").update(JSON.stringify(access)).digest("hex").slice(0, 16);
}

function changed(personaId: string): Persona {
  appEvents.personaChanged(personaId);
  return personas.get(personaId)!;
}

export const personaGitHub = {
  /** Checks the token with GitHub (it must be able to work with repos) and saves it as the persona's account. */
  async connect(personaId: string, token: unknown): Promise<Persona> {
    const value = typeof token === "string" ? token.trim() : "";
    if (!value || /\s/.test(value) || value.length > 255) throw new GitHubError("Paste a GitHub token (it starts with ghp_ or github_pat_).");
    const { profile, id, listsScopes } = await lookUpAccount(value);
    if (listsScopes && !profile.scopes.includes("repo")) {
      throw new GitHubError(`That token can't work with repositories: give it the "repo" scope, or use a fine-grained token with access to the persona's repos.`);
    }
    if (id === github.identity()?.id) {
      throw new GitHubError(`@${profile.login} is your own account (TOT's GitHub connection). Use a token from the persona's own GitHub account.`);
    }
    const previous = personas.githubAccount(personaId);
    setSecret(secretName(personaId), value);
    personas.setGitHubAccount(personaId, {
      login: profile.login,
      name: profile.name,
      avatarUrl: profile.avatarUrl || null,
      id,
      // A different account starts read-only, whatever the previous one was allowed.
      allowWrites: previous?.id === id && previous.allowWrites,
      problem: null,
    });
    checked.set(personaId, Date.now());
    return changed(personaId);
  },

  setAllowWrites(personaId: string, allowWrites: boolean): Persona {
    const account = personas.githubAccount(personaId);
    if (!account) throw new GitHubError("Connect the persona's GitHub account first.");
    personas.setGitHubAccount(personaId, { ...account, allowWrites });
    return changed(personaId);
  },

  /** Forgets the token; agents working as the persona go back to the user's connection, if any. */
  disconnect(personaId: string): Persona {
    setSecret(secretName(personaId), "");
    personas.setGitHubAccount(personaId, null);
    checked.delete(personaId);
    return changed(personaId);
  },

  /** Notices a revoked or expired token, at most every few minutes (unless `force`); being offline isn't a problem. */
  async check(personaId: string, { force = false } = {}): Promise<void> {
    const token = getSecret(secretName(personaId));
    if (!token || !personas.githubAccount(personaId)) return;
    if (!force && Date.now() - (checked.get(personaId) ?? 0) < VALIDATE_EVERY_MS) return;
    checked.set(personaId, Date.now());
    const accepted = await tokenAccepted(token);
    // Only if that's still the saved token (the user may have reconnected meanwhile).
    const account = personas.githubAccount(personaId);
    if (accepted === null || !account || getSecret(secretName(personaId)) !== token) return;
    const problem = accepted ? null : "GitHub no longer accepts this persona's token. Connect a new one to keep its agents working on GitHub.";
    if (problem === account.problem) return;
    personas.setGitHubAccount(personaId, { ...account, problem });
    changed(personaId);
  },
};
