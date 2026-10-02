import { useEffect, useState, type FormEvent } from "react";
import { Lock } from "lucide-react";
import type { Agent, GitHubRepo } from "@shared/types";
import { api, errorMessage } from "../../lib/api";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { goToSettings, navigateToConversation, useStore } from "../../store";
import { Button } from "../ui/Button";
import { Callout } from "../ui/Callout";
import { Field } from "../ui/Field";
import { Modal, ModalBody, ModalFooter } from "../ui/Modal";

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
        <ModalBody className="space-y-3">
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
              className="input h-10 rounded-xl"
            />
          </Field>

          {connected && repos && repos.length > 0 && (
            <ul className="max-h-40 space-y-0.5 overflow-y-auto rounded-xl border border-hairline p-1">
              {repos.map((repo) => (
                <li key={repo.fullName}>
                  <button
                    type="button"
                    onClick={() => setSource(repo.url)}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-ui text-fg-muted transition-colors hover:bg-hover hover:text-fg"
                  >
                    {repo.private && <Lock className="size-3 shrink-0 text-fg-subtle" aria-label="Private" />}
                    <span className="shrink-0 font-medium">{repo.fullName}</span>
                    {repo.description && <span className="min-w-0 truncate text-fg-subtle">{repo.description}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}

          {!connected && (
            <p className="text-xs text-fg-subtle">
              Private repos need GitHub —{" "}
              <button
                type="button"
                onClick={() => {
                  onOpenChange(false);
                  goToSettings("github");
                }}
                className="link-muted"
              >
                Connect in Settings
              </button>
            </p>
          )}

          {error && (
            <Callout
              tone="danger"
              action={
                error.includes("Settings → Computer") ? (
                  <button type="button" onClick={openComputerSettings} className="link-muted">
                    Open Settings
                  </button>
                ) : undefined
              }
            >
              {error}
            </Callout>
          )}
        </ModalBody>

        <ModalFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!source.trim() || submitting}>
            {submitting ? "Starting…" : "Learn repo"}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
