import { useEffect, useState, type FormEvent } from "react";
import { Lock } from "lucide-react";
import type { Agent, GitHubRepo } from "@shared/types";
import { api, errorMessage } from "../../lib/api";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { goToSettings, navigateToConversation, useStore } from "../../store";
import { Button } from "../ui/Button";
import { Field } from "../ui/Field";
import { Modal } from "../ui/Modal";

type LearnRepoDialogProps = {
  agent: Agent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** A git URL, an SSH remote, or a filesystem path — none of these should be treated as a repo-name search. */
const URL_OR_PATH = /^(?:[a-z][a-z0-9+.-]*:\/\/|[\w.-]+@[\w.-]+:|[./~])/i;

/** Ask an agent to clone a repo (or use a folder it already has), study it, and write it up in its wiki. */
export function LearnRepoDialog({ agent, open, onOpenChange }: LearnRepoDialogProps) {
  const github = useStore((s) => s.github);
  const connected = Boolean(github?.connection);
  const [source, setSource] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repos, setRepos] = useState<GitHubRepo[] | null>(null);
  const debouncedSource = useDebouncedValue(source.trim(), 300);

  useEffect(() => {
    if (!open) return;
    setSource("");
    setError(null);
    setSubmitting(false);
  }, [open]);

  // While the field holds plain text (not a URL/path yet), show matching repos to pick from.
  useEffect(() => {
    if (!open || !connected || URL_OR_PATH.test(debouncedSource)) {
      setRepos(null);
      return;
    }
    let cancelled = false;
    api.listGithubRepos(debouncedSource || undefined).then(
      (list) => {
        if (!cancelled) setRepos(list);
      },
      () => {
        if (!cancelled) setRepos(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, connected, debouncedSource]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = source.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const { conversationId } = await api.learnRepo(agent.id, { source: trimmed });
      onOpenChange(false);
      navigateToConversation(conversationId);
    } catch (err) {
      setError(errorMessage(err));
      setSubmitting(false);
    }
  }

  function openComputerSettings() {
    onOpenChange(false);
    goToSettings("computer");
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Learn a repo">
      <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 space-y-3 px-5 py-4">
          <Field
            label={`GitHub URL or folder on ${agent.name}'s computer`}
            htmlFor="learn-repo-source"
            hint={`${agent.name} clones it on its computer, studies it, and writes wiki pages. You can watch in the chat.`}
          >
            <input
              id="learn-repo-source"
              value={source}
              onChange={(event) => setSource(event.target.value)}
              placeholder="https://github.com/acme/web"
              autoFocus
              autoComplete="off"
              className="input"
            />
          </Field>

          {connected && repos && repos.length > 0 && (
            <ul className="max-h-40 space-y-0.5 overflow-y-auto rounded-lg border border-white/[0.07] p-1">
              {repos.map((repo) => (
                <li key={repo.fullName}>
                  <button
                    type="button"
                    onClick={() => setSource(repo.url)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-zinc-300 transition-colors hover:bg-white/[0.06] hover:text-zinc-100"
                  >
                    {repo.private && <Lock className="size-3 shrink-0 text-zinc-500" aria-label="Private" />}
                    <span className="shrink-0 font-medium">{repo.fullName}</span>
                    {repo.description && <span className="min-w-0 truncate text-zinc-500">{repo.description}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {!connected && (
            <p className="text-xs text-zinc-500">
              Private repos need GitHub —{" "}
              <button
                type="button"
                onClick={() => {
                  onOpenChange(false);
                  goToSettings("github");
                }}
                className="font-medium underline-offset-2 hover:underline"
              >
                Connect in Settings
              </button>
            </p>
          )}

          {error && (
            <p className="rounded-lg bg-red-500/[0.08] px-3 py-2 text-sm text-red-300">
              {error}
              {error.includes("Settings → Computer") && (
                <>
                  {" "}
                  <button
                    type="button"
                    onClick={openComputerSettings}
                    className="font-medium underline underline-offset-2 hover:text-red-200"
                  >
                    Open Settings
                  </button>
                </>
              )}
            </p>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-end gap-2 border-t border-white/[0.06] px-5 py-4">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!source.trim() || submitting}>
            {submitting ? "Starting…" : "Learn repo"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
