import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import clsx from "clsx";
import { Check, LoaderCircle, Lock, SearchX } from "lucide-react";
import type { Agent, GitHubRepo } from "@shared/types";
import { api, errorMessage } from "../../lib/api";
import { relativeTime } from "../../lib/format";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { goToSettings, navigateToConversation, useStore } from "../../store";
import { Button } from "../ui/Button";
import { Callout } from "../ui/Callout";
import { Field } from "../ui/Field";
import { GitHubMark } from "../ui/GitHubMark";
import { Modal, ModalBody, ModalFooter } from "../ui/Modal";
import { SearchInput } from "../ui/SearchInput";
import { Skeleton } from "../ui/Skeleton";

type LearnRepoDialogProps = {
  agent: Agent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** A git URL, an SSH remote, or a filesystem path — none of these should be treated as a repo-name search. */
const URL_OR_PATH = /^(?:[a-z][a-z0-9+.-]*:\/\/|[\w.-]+@[\w.-]+:|[./~])/i;
const HINT = (name: string) =>
  `${name} clones it, studies every part in depth, and writes it up as the repo's own brain, shareable with your other agents. Big repos can take a while — follow along in the chat. Learning it again later only re-studies what changed.`;
/** "acme/web" — a GitHub repo by name, even one that isn't in the user's list. */
const OWNER_REPO = /^[\w.-]+\/[\w.-]+$/;

type RepoList = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; repos: GitHubRepo[] };

/** Ask an agent to clone a repo (or use a folder it already has), study it, and write it up in its wiki. */
export function LearnRepoDialog({ agent, open, onOpenChange }: LearnRepoDialogProps) {
  const github = useStore((s) => s.github);
  const connection = github?.connection ?? null;
  const [source, setSource] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setSource("");
    setError(null);
    setSubmitting(false);
  }, [open]);

  async function learn(target: string) {
    if (!target || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const { conversationId } = await api.learnRepo(agent.id, { source: target });
      onOpenChange(false);
      navigateToConversation(conversationId);
    } catch (err) {
      setError(errorMessage(err));
      setSubmitting(false);
    }
  }

  function openSettings(section: "computer" | "github") {
    onOpenChange(false);
    goToSettings(section);
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Learn a repo">
      {connection ? (
        <RepoPicker
          agent={agent}
          login={connection.login}
          source={source}
          onSourceChange={setSource}
          submitting={submitting}
          onLearn={learn}
          onCancel={() => onOpenChange(false)}
          error={error && <LearnError error={error} onOpenComputer={() => openSettings("computer")} />}
        />
      ) : (
        <form
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            void learn(source.trim());
          }}
          className="flex min-h-0 flex-1 flex-col"
        >
          <ModalBody className="space-y-3">
            <Field
              label={`GitHub URL or folder on ${agent.name}'s computer`}
              htmlFor="learn-repo-source"
              hint={HINT(agent.name)}
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

            {/* `github` is null while its status is still loading: don't flash the nudge. */}
            {github && (
              <div className="flex items-center gap-2.5 rounded-xl border border-hairline px-3 py-2.5 text-ui text-fg-muted">
                <GitHubMark className="size-4 shrink-0 text-fg" />
                <span className="min-w-0 flex-1">Connect GitHub to pick from your repos, including private ones.</span>
                <button type="button" onClick={() => openSettings("github")} className="link-muted shrink-0">
                  Connect
                </button>
              </div>
            )}

            {error && <LearnError error={error} onOpenComputer={() => openSettings("computer")} />}
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
      )}
    </Modal>
  );
}

type RepoPickerProps = {
  agent: Agent;
  login: string;
  source: string;
  onSourceChange: (value: string) => void;
  submitting: boolean;
  onLearn: (target: string) => void;
  onCancel: () => void;
  error: ReactNode;
};

/** GitHub connected: search and pick one of the user's repos, or paste a URL / folder path instead. */
function RepoPicker({ agent, login, source, onSourceChange, submitting, onLearn, onCancel, error }: RepoPickerProps) {
  const query = source.trim();
  const isUrlOrPath = URL_OR_PATH.test(query);
  const debouncedQuery = useDebouncedValue(isUrlOrPath ? "" : query, 250);
  const [list, setList] = useState<RepoList>({ state: "loading" });
  // The last results stay on screen (dimmed) while the next search loads, so the list doesn't flicker.
  const [shown, setShown] = useState<GitHubRepo[] | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isUrlOrPath) return;
    let cancelled = false;
    setList({ state: "loading" });
    api.listGithubRepos(debouncedQuery || undefined).then(
      (repos) => {
        if (cancelled) return;
        setList({ state: "ready", repos });
        setShown(repos);
        setActive((current) => (current && repos.some((repo) => repo.fullName === current) ? current : null));
      },
      (err) => {
        if (!cancelled) setList({ state: "error", message: errorMessage(err) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, isUrlOrPath, reloadKey]);

  const repos = shown ?? [];
  const searching = !isUrlOrPath && (list.state === "loading" || debouncedQuery !== query);
  const selected = repos.find((repo) => repo.fullName === active) ?? null;
  const ownerRepoFallback = !selected && OWNER_REPO.test(query) ? `https://github.com/${query}` : null;
  const target = isUrlOrPath ? query : (selected?.url ?? ownerRepoFallback ?? "");

  function move(delta: number) {
    if (repos.length === 0) return;
    const index = repos.findIndex((repo) => repo.fullName === active);
    const next = index === -1 ? (delta > 0 ? 0 : repos.length - 1) : (index + delta + repos.length) % repos.length;
    setActive(repos[next].fullName);
    listRef.current?.querySelector(`[data-index="${next}"]`)?.scrollIntoView({ block: "nearest" });
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (isUrlOrPath) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      move(event.key === "ArrowDown" ? 1 : -1);
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onLearn(target);
      }}
      className="flex min-h-0 flex-1 flex-col"
    >
      <ModalBody className="space-y-3">
        <Field
          label="Repository"
          htmlFor="learn-repo-source"
          hint={HINT(agent.name)}
        >
          <SearchInput
            id="learn-repo-source"
            value={source}
            onChange={(event) => {
              onSourceChange(event.target.value);
              setActive(null);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search your repos, or paste a URL or folder"
            autoFocus
            role="combobox"
            aria-expanded={!isUrlOrPath}
            aria-controls="learn-repo-list"
            aria-activedescendant={selected ? optionId(selected) : undefined}
            trailing={
              searching && shown ? <LoaderCircle aria-label="Searching" className="size-4 animate-spin text-fg-subtle" /> : undefined
            }
          />
        </Field>

        {isUrlOrPath ? (
          <p className="flex items-center gap-2 rounded-xl border border-hairline px-3 py-2.5 text-ui text-fg-muted">
            <GitHubMark className="size-4 shrink-0 text-fg-subtle" />
            <span className="min-w-0 truncate">
              Learn <span className="font-medium text-fg">{query}</span>
            </span>
          </p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-hairline">
            <div className="flex items-center justify-between gap-2 border-b border-hairline px-3 py-2 text-xs text-fg-subtle">
              <span>{query ? "Matching repos" : "Your repos, recently pushed"}</span>
              <span className="flex min-w-0 items-center gap-1.5">
                <GitHubMark className="size-3.5 shrink-0" />
                <span className="truncate">{login}</span>
              </span>
            </div>

            <div ref={listRef} id="learn-repo-list" role="listbox" aria-label="Your GitHub repos" className="h-64 overflow-y-auto p-1">
              {list.state === "error" ? (
                <ListMessage
                  icon={<GitHubMark className="size-5" />}
                  title="Couldn't load your repos"
                  detail={list.message}
                  action={
                    <Button type="button" variant="secondary" size="sm" onClick={() => setReloadKey((key) => key + 1)}>
                      Try again
                    </Button>
                  }
                />
              ) : !shown ? (
                <div aria-busy="true" aria-label="Loading your repos" className="space-y-1">
                  {[0.55, 0.4, 0.65, 0.35, 0.5, 0.45].map((width, i) => (
                    <div key={i} className="flex h-12 items-center gap-3 px-2.5">
                      <Skeleton className="size-4 shrink-0 rounded" />
                      <div className="flex-1 space-y-1.5">
                        <Skeleton className="h-3" style={{ width: `${width * 100}%` }} />
                        <Skeleton className="h-2.5" style={{ width: `${(width + 0.2) * 100}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              ) : repos.length === 0 && !searching ? (
                <ListMessage
                  icon={<SearchX className="size-5" />}
                  title={query ? `No repos match “${query}”` : "No repos on this account"}
                  detail={
                    ownerRepoFallback
                      ? `Press Learn repo to use github.com/${query}.`
                      : "Paste a GitHub URL or a folder path above instead."
                  }
                />
              ) : (
                <div className={clsx("space-y-0.5 transition-opacity", searching && "opacity-60")}>
                  {repos.map((repo, index) => (
                    <RepoOption
                      key={repo.fullName}
                      repo={repo}
                      index={index}
                      selected={repo.fullName === active}
                      onSelect={() => setActive(repo.fullName)}
                      onLearn={() => onLearn(repo.url)}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {error}
      </ModalBody>

      <ModalFooter>
        <p className="mr-auto min-w-0 truncate text-xs text-fg-subtle">
          {selected ? (
            <>
              Selected <span className="font-medium text-fg-muted">{selected.fullName}</span>
            </>
          ) : (
            !isUrlOrPath && "↑↓ to choose, Enter to learn"
          )}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!target || submitting}>
            {submitting ? "Starting…" : "Learn repo"}
          </Button>
        </div>
      </ModalFooter>
    </form>
  );
}

function optionId(repo: GitHubRepo) {
  return `learn-repo-${repo.fullName.replace(/[^\w-]/g, "-")}`;
}

type RepoOptionProps = {
  repo: GitHubRepo;
  index: number;
  selected: boolean;
  onSelect: () => void;
  onLearn: () => void;
};

/** One repo: click to select, double-click to learn it right away. Focus stays in the search field. */
function RepoOption({ repo, index, selected, onSelect, onLearn }: RepoOptionProps) {
  const slash = repo.fullName.indexOf("/");
  return (
    <div
      id={optionId(repo)}
      role="option"
      aria-selected={selected}
      data-index={index}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onSelect}
      onDoubleClick={onLearn}
      className={clsx(
        "flex cursor-pointer items-center gap-3 rounded-lg px-2.5 py-2 transition-colors",
        selected ? "bg-selected" : "hover:bg-hover",
      )}
    >
      <span className="grid size-4 shrink-0 place-items-center text-fg-subtle">
        {repo.private ? <Lock className="size-3.5" aria-label="Private" /> : <GitHubMark className="size-3.5" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-baseline gap-2">
          <span className="truncate text-sm">
            <span className="text-fg-muted">{repo.fullName.slice(0, slash + 1)}</span>
            <span className="font-medium text-fg">{repo.fullName.slice(slash + 1)}</span>
          </span>
          {repo.pushedAt && (
            <span className="ml-auto shrink-0 text-xs text-fg-subtle tabular-nums">{relativeTime(repo.pushedAt)}</span>
          )}
        </div>
        {repo.description && <p className="truncate text-xs text-fg-subtle">{repo.description}</p>}
      </div>
      <Check aria-hidden="true" className={clsx("size-4 shrink-0 text-fg", !selected && "invisible")} />
    </div>
  );
}

function ListMessage({ icon, title, detail, action }: { icon: ReactNode; title: string; detail?: string; action?: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
      <span className="mb-1 text-fg-subtle">{icon}</span>
      <p className="text-sm font-medium text-fg">{title}</p>
      {detail && <p className="text-xs leading-relaxed text-fg-subtle">{detail}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

function LearnError({ error, onOpenComputer }: { error: string; onOpenComputer: () => void }) {
  return (
    <Callout
      tone="danger"
      action={
        error.includes("Settings → Computer") ? (
          <button type="button" onClick={onOpenComputer} className="link-muted">
            Open Settings
          </button>
        ) : undefined
      }
    >
      {error}
    </Callout>
  );
}
