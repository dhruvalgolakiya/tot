import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import clsx from "clsx";
import { RadioGroup } from "radix-ui";
import { toast } from "sonner";
import { Check, FolderOpen, LoaderCircle, Lock } from "lucide-react";
import type { GitHubRepo, GitHubStatus, Project, ProjectKind } from "@shared/types";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { api, ApiError, errorMessage } from "../../lib/api";
import { totDesktop } from "../../lib/desktop";
import { onDevice } from "../../lib/devices";
import { relativeTime } from "../../lib/format";
import { selectDevice, useDevices } from "../../lib/remote";
import {
  createProject,
  grantProjectFolder,
  isOwnerRepo,
  nameFromSource,
  PROJECT_ICONS,
  setNewProjectOpen,
  tildePath,
  useProjects,
} from "../../lib/projects";
import { goToSettings, navigateToConversation, navigateToProject, notifyError, selectActiveAgent, useStore } from "../../store";
import { Button } from "../ui/Button";
import { Callout } from "../ui/Callout";
import { Field } from "../ui/Field";
import { GitHubMark } from "../ui/GitHubMark";
import { Modal, ModalBody, ModalFooter } from "../ui/Modal";
import { SearchInput } from "../ui/SearchInput";
import { Skeleton } from "../ui/Skeleton";
import { FolderConsentText, folderConsentTitle } from "./FolderConsent";

const KINDS: { kind: ProjectKind; label: string; hint: string }[] = [
  { kind: "github", label: "A GitHub repo", hint: "Yours, or any owner/name" },
  { kind: "folder", label: "A folder on this Mac", hint: "Used in place, with your OK" },
  { kind: "none", label: "Something else", hint: "No files: a topic, a client, a launch" },
];

/** A git URL (not a name to search for). */
const GIT_URL = /^(?:https?:\/\/|git@|ssh:\/\/)/i;

/**
 * "New project": one question — what are you working on? A GitHub repo, a folder on this Mac (asks
 * for consent before it's created), or something else. Then it opens the new project, and with
 * "Learn it now" the agent starts building its brain. "What do you want built first?" (module 12)
 * goes to the project's Lead, which the project page then shows at work.
 */
export function NewProjectDialog() {
  const open = useProjects((s) => s.newProjectOpen);
  const projects = useProjects((s) => s.projects);
  const agent = useStore(selectActiveAgent);
  // Made on the active agent's device (module 07), with that device's GitHub and folders.
  const device = agent?.deviceId ?? null;
  const deviceName = useDevices(selectDevice(device))?.name ?? null;
  const localGithub = useStore((s) => s.github);
  const [remoteGithub, setRemoteGithub] = useState<GitHubStatus | null>(null);
  useEffect(() => {
    setRemoteGithub(null);
    if (!device || !open) return;
    onDevice(device, () => api.getGithubStatus()).then(setRemoteGithub, () => {});
  }, [device, open]);
  const github = device ? remoteGithub : localGithub;
  const githubLogin = github?.connection?.login ?? null;
  const githubKnown = github !== null;

  const [kind, setKind] = useState<ProjectKind>("github");
  const [repoQuery, setRepoQuery] = useState("");
  const [repo, setRepo] = useState<string | null>(null);
  const [folder, setFolder] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [learn, setLearn] = useState(true);
  const [firstMessage, setFirstMessage] = useState("");
  const [step, setStep] = useState<"form" | "consent">("form");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<{ message: string; existing: Project | null } | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setKind("github");
    setRepoQuery("");
    setRepo(null);
    setFolder("");
    setName("");
    setNameTouched(false);
    setLearn(true);
    setFirstMessage("");
    setStep("form");
    setSubmitting(false);
    setError(null);
  }, [open]);

  const typedRepo = repoQuery.trim();
  const source =
    kind === "github"
      ? (repo ?? (isOwnerRepo(typedRepo) || GIT_URL.test(typedRepo) ? typedRepo : ""))
      : kind === "folder"
        ? folder.trim()
        : "";
  const shownName = nameTouched || kind === "none" ? name : nameFromSource(source);
  const canCreate = shownName.trim().length > 0 && (kind === "none" || source.length > 0);

  function pickKind(next: ProjectKind) {
    setKind(next);
    setError(null);
    // A name typed for one kind still fits another; one filled in from a repo or folder doesn't.
    if (!nameTouched) setName("");
    // A topic is just its name (the repo and folder fields focus themselves when they appear).
    if (next === "none") requestAnimationFrame(() => nameRef.current?.focus());
  }

  async function create() {
    if (!canCreate || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      let project = await createProject(
        {
          kind,
          name: shownName.trim(),
          ...(kind === "none" ? {} : { source }),
          ...(kind === "folder" ? { grant: true } : {}),
          // Module 12: sent to the new project's Lead (this agent's), which the project page opens on.
          ...(firstMessage.trim() ? { firstMessage: firstMessage.trim(), agentId: agent?.id ?? null } : {}),
        },
        device,
      );
      // A server from before `grant` on create: allow it in a second call (quietly, if that's not there either).
      if (kind === "folder" && !project.folderGranted) project = await grantProjectFolder(project.id).catch(() => project);
      setNewProjectOpen(false);
      navigateToProject(project.id);
      if (learn && kind !== "none" && agent) startLearning(project, agent.id, agent.name);
    } catch (err) {
      const existing = err instanceof ApiError && err.status === 409 ? findExisting(projects, kind, source) : null;
      setError({ message: errorMessage(err), existing });
      setStep("form");
      setSubmitting(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!canCreate) return;
    if (kind === "folder") setStep("consent");
    else void create();
  }

  const consentFolder = tildePath(folder.trim());

  return (
    <Modal
      open={open}
      onOpenChange={setNewProjectOpen}
      title={step === "consent" ? folderConsentTitle(consentFolder) : "New project"}
      className="max-w-lg"
    >
      {step === "consent" ? (
        <>
          <ModalBody className="pb-2">
            <FolderConsentText />
          </ModalBody>
          <ModalFooter divider={false}>
            <Button variant="ghost" disabled={submitting} onClick={() => setStep("form")}>
              Cancel
            </Button>
            <Button variant="primary" autoFocus disabled={submitting} onClick={() => void create()}>
              {submitting ? "Allowing…" : "Allow"}
            </Button>
          </ModalFooter>
        </>
      ) : (
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <ModalBody className="space-y-5">
            <div className="space-y-2">
              <p id="new-project-kind" className="text-sm font-medium text-fg">
                What are you working on?
              </p>
              <RadioGroup.Root
                value={kind}
                onValueChange={(value) => pickKind(value as ProjectKind)}
                aria-labelledby="new-project-kind"
                className="divide-y divide-hairline overflow-hidden rounded-xl border border-edge"
              >
                {KINDS.map((option) => {
                  const Icon = PROJECT_ICONS[option.kind];
                  return (
                    <RadioGroup.Item
                      key={option.kind}
                      value={option.kind}
                      className="group flex w-full items-center gap-3 px-3.5 py-2.5 text-left transition-colors hover:bg-hover focus-visible:-outline-offset-2 data-[state=checked]:bg-fill"
                    >
                      <span className="grid size-4 shrink-0 place-items-center rounded-full border border-fg-faint transition-colors group-data-[state=checked]:border-fg">
                        <RadioGroup.Indicator className="size-2 rounded-full bg-fg" />
                      </span>
                      <Icon aria-hidden="true" className="size-4 shrink-0 text-fg-muted group-data-[state=checked]:text-fg" />
                      <span className="flex min-w-0 flex-1 flex-col gap-x-3 sm:flex-row sm:items-baseline sm:justify-between">
                        <span className="text-sm font-medium text-fg">
                          {option.kind === "folder" && deviceName ? `A folder on ${deviceName}` : option.label}
                        </span>
                        <span className="truncate text-xs text-fg-subtle">{option.hint}</span>
                      </span>
                    </RadioGroup.Item>
                  );
                })}
              </RadioGroup.Root>
            </div>

            {kind === "github" &&
              (githubLogin ? (
                <RepoPicker
                  device={device}
                  login={githubLogin}
                  query={repoQuery}
                  onQueryChange={(value) => {
                    setRepoQuery(value);
                    setRepo(null);
                  }}
                  selected={repo}
                  onSelect={setRepo}
                />
              ) : (
                <div className="space-y-2.5">
                  <Field label="Repository" htmlFor="new-project-repo" hint="Type it as owner/name, or paste its URL.">
                    <input
                      id="new-project-repo"
                      value={repoQuery}
                      onChange={(event) => setRepoQuery(event.target.value)}
                      placeholder="acme/web"
                      autoFocus
                      autoComplete="off"
                      spellCheck={false}
                      className="input"
                    />
                  </Field>
                  {githubKnown && (
                    <p className="flex items-center gap-2 rounded-xl border border-hairline px-3 py-2.5 text-xs text-fg-muted">
                      <GitHubMark className="size-3.5 shrink-0" />
                      <span className="min-w-0 flex-1">Connect GitHub to pick from your repos, private ones too.</span>
                      <button
                        type="button"
                        className="link-muted shrink-0"
                        onClick={() => {
                          setNewProjectOpen(false);
                          goToSettings("github");
                        }}
                      >
                        Connect
                      </button>
                    </p>
                  )}
                </div>
              ))}

            {kind === "folder" && <FolderPicker device={device} value={folder} onChange={setFolder} projects={projects} />}

            <Field label="Name" htmlFor="new-project-name">
              <input
                ref={nameRef}
                id="new-project-name"
                value={shownName}
                onChange={(event) => {
                  setName(event.target.value);
                  setNameTouched(true);
                }}
                placeholder={kind === "none" ? "Q4 launch" : kind === "github" ? "Filled in from the repo" : "Filled in from the folder"}
                maxLength={60}
                autoComplete="off"
                className="input"
              />
            </Field>

            <Field
              label="What do you want built first?"
              htmlFor="new-project-first"
              hint="Optional. The project's Lead starts on it right away."
            >
              <textarea
                id="new-project-first"
                value={firstMessage}
                onChange={(event) => setFirstMessage(event.target.value)}
                rows={3}
                maxLength={8000}
                placeholder={kind === "none" ? "A launch plan: what to do, who does it, by when." : "A settings page where people can change their email."}
                className="input min-h-20 resize-y rounded-xl leading-relaxed"
              />
            </Field>

            {kind !== "none" && (
              <label className="flex items-start gap-2.5 text-sm text-fg">
                <input
                  type="checkbox"
                  checked={learn}
                  onChange={(event) => setLearn(event.target.checked)}
                  className="mt-0.5 size-4 accent-fg"
                />
                <span>
                  Learn it now
                  <span className="block text-xs text-fg-subtle">
                    {agent ? `${agent.name} studies the code` : "An agent studies the code"} and builds the project's brain.
                  </span>
                </span>
              </label>
            )}

            {error && (
              <Callout
                tone="danger"
                action={
                  error.existing && (
                    <button
                      type="button"
                      className="link-muted"
                      onClick={() => {
                        setNewProjectOpen(false);
                        navigateToProject(error.existing!.id);
                      }}
                    >
                      Open it
                    </button>
                  )
                }
              >
                {error.message}
              </Callout>
            )}
          </ModalBody>

          <ModalFooter>
            <Button variant="ghost" onClick={() => setNewProjectOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!canCreate || submitting}>
              {submitting ? "Creating…" : kind === "folder" ? "Continue" : "Create"}
            </Button>
          </ModalFooter>
        </form>
      )}
    </Modal>
  );
}

/** Learn a repo into the new project's brain, in the background; the study chat is filed under the project. */
function startLearning(project: Project, agentId: string, agentName: string) {
  api.learnProject(project.id, agentId).then(
    ({ conversationId }) =>
      toast.success(`${agentName} is learning ${project.name}`, {
        action: {
          label: "Open",
          onClick: () => navigateToConversation(conversationId),
        },
      }),
    notifyError,
  );
}

/** The project a 409 ("there's already a project for that") is about, when it can be told from the source typed. */
function findExisting(projects: Project[], kind: ProjectKind, source: string): Project | null {
  const want = (kind === "folder" ? tildePath(source) : source.replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, ""))
    .replace(/\/+$/, "")
    .toLowerCase();
  return (
    projects.find((p) => p.kind === kind && p.source && (kind === "folder" ? tildePath(p.source) : p.source).toLowerCase() === want) ?? null
  );
}

// ---------------------------------------------------------------------------
// A GitHub repo: search the user's repos, or type owner/name
// ---------------------------------------------------------------------------

type RepoList = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; repos: GitHubRepo[] };

type RepoPickerProps = {
  /** The paired device whose GitHub to list (module 07); null for this device's. */
  device: string | null;
  login: string;
  query: string;
  onQueryChange: (value: string) => void;
  selected: string | null;
  onSelect: (fullName: string) => void;
};

/** Also module 11's Add repo dialog (AddRepoDialog.tsx). */
export function RepoPicker({ device, login, query, onQueryChange, selected, onSelect }: RepoPickerProps) {
  const text = query.trim();
  const isUrl = GIT_URL.test(text);
  const search = useDebouncedValue(isUrl ? "" : text, 250);
  const [list, setList] = useState<RepoList>({ state: "loading" });
  // The last results stay (dimmed) while the next search loads, so the list doesn't flicker.
  const [shown, setShown] = useState<GitHubRepo[] | null>(null);
  const [reload, setReload] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isUrl) return;
    let cancelled = false;
    setList({ state: "loading" });
    onDevice(device, () => api.listGithubRepos(search || undefined)).then(
      (repos) => {
        if (cancelled) return;
        setList({ state: "ready", repos });
        setShown(repos);
      },
      (err) => !cancelled && setList({ state: "error", message: errorMessage(err) }),
    );
    return () => {
      cancelled = true;
    };
  }, [search, isUrl, reload]);

  const repos = shown ?? [];
  const searching = !isUrl && (list.state === "loading" || search !== text);

  function move(delta: number) {
    if (!repos.length) return;
    const index = repos.findIndex((r) => r.fullName === selected);
    const next = index === -1 ? (delta > 0 ? 0 : repos.length - 1) : (index + delta + repos.length) % repos.length;
    onSelect(repos[next]!.fullName);
    listRef.current?.querySelector(`[data-index="${next}"]`)?.scrollIntoView({ block: "nearest" });
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (isUrl || (event.key !== "ArrowDown" && event.key !== "ArrowUp")) return;
    event.preventDefault();
    move(event.key === "ArrowDown" ? 1 : -1);
  }

  return (
    <div className="space-y-1.5">
      <label htmlFor="new-project-repo" className="block text-sm font-medium text-fg">
        Repository
      </label>
      <SearchInput
        id="new-project-repo"
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Search your repos, or type owner/name"
        autoFocus
        spellCheck={false}
        role="combobox"
        aria-expanded={!isUrl}
        aria-controls="new-project-repos"
        trailing={searching && shown ? <LoaderCircle aria-label="Searching" className="size-4 animate-spin text-fg-subtle" /> : undefined}
      />
      {!isUrl && (
        <div className="overflow-hidden rounded-xl border border-hairline">
          <div className="flex items-center justify-between gap-2 border-b border-hairline px-3 py-1.5 text-xs text-fg-subtle">
            <span>{text ? "Matching repos" : "Your repos, recently pushed"}</span>
            <span className="flex min-w-0 items-center gap-1.5">
              <GitHubMark className="size-3.5 shrink-0" />
              <span className="truncate">{login}</span>
            </span>
          </div>
          <div ref={listRef} id="new-project-repos" role="listbox" aria-label="Your GitHub repos" className="h-44 overflow-y-auto p-1">
            {list.state === "error" ? (
              <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
                <p className="text-xs leading-relaxed text-fg-subtle">{list.message}</p>
                <Button size="sm" onClick={() => setReload((n) => n + 1)}>
                  Try again
                </Button>
              </div>
            ) : !shown ? (
              <div aria-busy="true" aria-label="Loading your repos" className="space-y-1">
                {[0.5, 0.35, 0.6, 0.4].map((width) => (
                  <div key={width} className="flex h-9 items-center gap-3 px-2.5">
                    <Skeleton className="size-3.5 shrink-0 rounded" />
                    <Skeleton className="h-3" style={{ width: `${width * 100}%` }} />
                  </div>
                ))}
              </div>
            ) : repos.length === 0 && !searching ? (
              <p className="flex h-full items-center justify-center px-6 text-center text-xs leading-relaxed text-fg-subtle">
                {isOwnerRepo(text) ? `No repo of yours matches. Create uses github.com/${text}.` : `No repos match “${text}”.`}
              </p>
            ) : (
              <div className={clsx("space-y-px transition-opacity", searching && "opacity-60")}>
                {repos.map((repo, index) => (
                  <RepoOption
                    key={repo.fullName}
                    repo={repo}
                    index={index}
                    selected={repo.fullName === selected}
                    onSelect={() => onSelect(repo.fullName)}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function RepoOption({ repo, index, selected, onSelect }: { repo: GitHubRepo; index: number; selected: boolean; onSelect: () => void }) {
  const slash = repo.fullName.indexOf("/");
  return (
    <div
      role="option"
      aria-selected={selected}
      data-index={index}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onSelect}
      className={clsx(
        "flex h-9 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 transition-colors",
        selected ? "bg-selected" : "hover:bg-hover",
      )}
    >
      <span className="grid size-4 shrink-0 place-items-center text-fg-subtle">
        {repo.private ? <Lock className="size-3.5" aria-label="Private" /> : <GitHubMark className="size-3.5" />}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm">
        <span className="text-fg-muted">{repo.fullName.slice(0, slash + 1)}</span>
        <span className="font-medium text-fg">{repo.fullName.slice(slash + 1)}</span>
      </span>
      {repo.pushedAt && <span className="shrink-0 text-xs text-fg-subtle tabular-nums">{relativeTime(repo.pushedAt)}</span>}
      <Check aria-hidden="true" className={clsx("size-4 shrink-0 text-fg", !selected && "invisible")} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// A folder on this Mac: a path, or one of the recent git folders
// ---------------------------------------------------------------------------

type RecentFolder = { path: string; label: string };

/** Also module 11's Add repo dialog (AddRepoDialog.tsx), where `exclude` holds the project's own folders. */
/** Hosts a browser on this Mac itself uses for TOT. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function FolderPicker({
  device,
  value,
  onChange,
  projects,
  exclude = [],
}: {
  device: string | null;
  value: string;
  onChange: (value: string) => void;
  projects: Project[];
  exclude?: string[];
}) {
  const [recent, setRecent] = useState<RecentFolder[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Quiet when the server can't list them (yet): the path field is enough.
    onDevice(device, () => api.recentProjectFolders()).then(
      (folders) => !cancelled && setRecent(Array.isArray(folders) ? folders : []),
      () => !cancelled && setRecent([]),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  // Folders that are already projects aren't offered again.
  const taken = useMemo(
    () => new Set([...projects.filter((p) => p.kind === "folder" && p.source).map((p) => p.source), ...exclude]),
    [projects, exclude],
  );
  const offered = (recent ?? []).filter((folder) => !taken.has(folder.path)).slice(0, 8);

  // macOS's folder picker: a sheet in the Mac app, else opened by the server for a browser on this Mac. Not for a
  // folder on another device (this Mac's picker would show this Mac's folders), nor from a phone.
  const canPick = !device && (Boolean(totDesktop?.pickFolder) || LOOPBACK_HOSTS.has(window.location.hostname));
  const [picking, setPicking] = useState(false);
  async function pick() {
    setPicking(true);
    try {
      const path = totDesktop?.pickFolder ? await totDesktop.pickFolder() : (await api.pickProjectFolder()).path;
      if (path) onChange(tildePath(path));
    } catch (error) {
      notifyError(error);
    } finally {
      setPicking(false);
    }
  }

  return (
    <Field label="Folder" htmlFor="new-project-folder" hint="A git folder inside your home folder works best.">
      <div className="flex items-center gap-2">
        <input
          id="new-project-folder"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="~/code/web"
          autoFocus
          autoComplete="off"
          spellCheck={false}
          className="input min-w-0 flex-1 font-mono text-ui"
        />
        {canPick && (
          <Button className="shrink-0" disabled={picking} onClick={() => void pick()}>
            {picking ? <LoaderCircle className="animate-spin" /> : <FolderOpen />}
            Choose…
          </Button>
        )}
      </div>
      {offered.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          <span className="mr-0.5 text-xs text-fg-subtle">Recent</span>
          {offered.map((folder) => {
            const picked = tildePath(value.trim()) === folder.label;
            return (
              <button
                key={folder.path}
                type="button"
                title={folder.label}
                aria-pressed={picked}
                onClick={() => onChange(folder.label)}
                className="inline-flex h-7 max-w-40 items-center rounded-full border border-edge px-2.5 text-xs font-medium text-fg-muted transition-colors hover:border-edge-strong hover:bg-hover hover:text-fg aria-pressed:border-edge-strong aria-pressed:bg-selected aria-pressed:text-fg"
              >
                <span className="truncate">{nameFromSource(folder.label)}</span>
              </button>
            );
          })}
        </div>
      )}
    </Field>
  );
}
