import { rmSync } from "node:fs";
import { join } from "node:path";
import type { ComputerKind } from "../../shared/types.ts";
import { computers } from "../data/computers.ts";
import type { GitHubIdentity } from "../github.ts";
import { githubAccessFor, githubFingerprintFor } from "../persona-github.ts";
import { boatBackend } from "./boat.ts";
import { localBackend } from "./local.ts";
import type { ComputerBackend } from "./types.ts";

const backendFor = (kind: ComputerKind): ComputerBackend => (kind === "boat" ? boatBackend : localBackend);

/**
 * Keeps each agent computer's GitHub login in step with the account its agent
 * uses (its persona's own, else the app's connection; see githubAccessFor):
 * git (credential store) is logged in as that account so private repos clone,
 * and commits are attributed to it (the persona step that runs next may make
 * the persona the author). While writes are off, gh stays logged out and git
 * pushes to GitHub are rewritten to an unreachable host — a guardrail rather
 * than a guarantee, since git's login could still write; the GitHub tools
 * themselves are read-only on GitHub's side. Runs before a computer is used
 * when the account changed, the computer just started, or a while has passed.
 * The token is written as files, never placed in a command line.
 */

/** Pushes are rewritten to this unreachable host while writes are off, so `git push` fails with a hint. */
export const PUSH_BLOCKED_HOST = "https://pushing-is-off-in-tot-settings.invalid/";
/** Re-apply the login this often even when nothing changed, undoing edits made on the computer. */
const RESYNC_MS = 10 * 60_000;

const synced = new Map<string, { fingerprint: string; at: number }>();

export const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;

/** How commits are attributed to the connected account (its noreply address keeps the real one private). */
export function githubAuthor(who: Pick<GitHubIdentity, "id" | "login" | "name">): { name: string; email: string } {
  return { name: who.name || who.login, email: `${who.id}+${who.login}@users.noreply.github.com` };
}

function hostsYaml(who: GitHubIdentity): string {
  return `github.com:
    users:
        ${who.login}:
            oauth_token: ${who.token}
    git_protocol: https
    oauth_token: ${who.token}
    user: ${who.login}
`;
}

/** Every way a push could name GitHub that git's credential store would answer for. */
function pushForms(login: string): string[] {
  return ["https://github.com/", "https://github.com:443/", `https://${login}@github.com/`, "git@github.com:", "ssh://git@github.com/"];
}

function loginScript(who: GitHubIdentity): string {
  const author = githubAuthor(who);
  return [
    "set -e",
    "chmod 600 ~/.git-credentials",
    who.allowWrites
      ? `chmod 600 ~/.config/gh/hosts.yml && { test -f ~/.config/gh/config.yml || printf 'version: "1"\\ngit_protocol: https\\n' > ~/.config/gh/config.yml; }`
      : "rm -f ~/.config/gh/hosts.yml",
    // An empty entry first resets helpers configured system-wide (e.g. the macOS keychain).
    "git config --global --replace-all credential.helper ''",
    "git config --global --add credential.helper store",
    // Commits are attributed to the connected account; an agent's own choice survives until the account changes.
    `if [ "$(git config --global tot.githubLogin || true)" != ${quote(who.login)} ]; then`,
    `  git config --global user.name ${quote(author.name)}`,
    `  git config --global user.email ${quote(author.email)}`,
    `  git config --global tot.githubLogin ${quote(who.login)}`,
    "fi",
    `git config --global --unset-all url.${PUSH_BLOCKED_HOST}.pushInsteadOf || true`,
    ...(who.allowWrites
      ? []
      : [
          ...pushForms(who.login).map((form) => `git config --global --add url.${PUSH_BLOCKED_HOST}.pushInsteadOf ${quote(form)}`),
        ]),
  ].join("\n");
}

const LOGOUT_SCRIPT = [
  "rm -f ~/.git-credentials ~/.config/gh/hosts.yml",
  "git config --global --unset-all credential.helper",
  `git config --global --unset-all url.${PUSH_BLOCKED_HOST}.pushInsteadOf`,
  "git config --global --unset tot.githubLogin",
  "true",
].join("; ");

/** Brings one agent's computer's GitHub login up to date; a no-op when nothing changed recently. */
export async function syncGitHubLogin(
  agentId: string,
  computer: { backend: ComputerBackend; externalId: string; event?: "created" | "resumed" },
): Promise<void> {
  const fingerprint = githubFingerprintFor(agentId);
  const last = synced.get(computer.externalId);
  if (!computer.event && last?.fingerprint === fingerprint && Date.now() - last.at < RESYNC_MS) return;
  const { backend, externalId } = computer;
  const who = githubAccessFor(agentId);
  // A computer that was never logged in has nothing to log out of.
  if (!who && !synced.has(externalId)) {
    const probe = await backend.exec(externalId, "test -f ~/.git-credentials || git config --global tot.githubLogin", { timeoutMs: 15_000 });
    if (probe.exitCode !== 0) {
      synced.set(externalId, { fingerprint, at: Date.now() });
      return;
    }
  }
  if (who) {
    await backend.upload(externalId, ".git-credentials", Buffer.from(`https://${who.login}:${who.token}@github.com\n`));
    if (who.allowWrites) await backend.upload(externalId, ".config/gh/hosts.yml", Buffer.from(hostsYaml(who)));
  }
  const result = await backend.exec(externalId, who ? loginScript(who) : LOGOUT_SCRIPT, { timeoutMs: 30_000 });
  if (result.exitCode !== 0) throw new Error(`Couldn't update the computer's GitHub login: ${result.stderr.trim().slice(0, 300)}`);
  synced.set(externalId, { fingerprint, at: Date.now() });
}

/**
 * After a GitHub account changed (disconnected, connected or switched for a persona, writes
 * toggled, an agent's persona changed), takes the old login off the affected computers right
 * away instead of on next use: local workspaces lose it directly on disk (and log in again as the
 * right account when next used), running cloud computers are brought up to date over the
 * network. Stopped cloud computers catch up when they next start. Computers whose agent's
 * account didn't change are left alone.
 */
export async function refreshGitHubLogins(): Promise<void> {
  for (const record of computers.list()) {
    if (record.externalId && synced.get(record.externalId)?.fingerprint === githubFingerprintFor(record.agentId)) continue;
    try {
      if (record.kind === "local" && record.workspacePath) {
        for (const file of [".git-credentials", ".config/gh/hosts.yml"]) rmSync(join(record.workspacePath, file), { force: true });
        if (record.externalId) synced.delete(record.externalId);
      } else if (record.externalId && record.state === "running") {
        // Next use re-applies the persona's git author (persona-identity.ts) if this changed it.
        await syncGitHubLogin(record.agentId, { backend: backendFor(record.kind), externalId: record.externalId });
      }
    } catch (err) {
      console.warn("[tot] couldn't update a computer's GitHub login:", err instanceof Error ? err.message : err);
    }
  }
}

/** Forget a computer (destroyed), so a new one with the same id gets synced. */
export function forgetGitHubLogin(externalId: string): void {
  synced.delete(externalId);
}
