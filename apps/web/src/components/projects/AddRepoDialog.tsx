import { useEffect, useMemo, useState, type FormEvent } from "react";
import { RadioGroup } from "radix-ui";
import type { GitHubStatus, Project, ProjectRepoKind } from "@shared/types";
import { api, errorMessage } from "../../lib/api";
import { onDevice } from "../../lib/devices";
import { addProjectRepo } from "../../lib/project-repos";
import { isOwnerRepo, nameFromSource, PROJECT_ICONS, tildePath, useProjects } from "../../lib/projects";
import { useStore } from "../../store";
import { Button } from "../ui/Button";
import { Callout } from "../ui/Callout";
import { Field } from "../ui/Field";
import { Modal, ModalBody, ModalFooter } from "../ui/Modal";
import { FolderConsentText, folderConsentTitle } from "./FolderConsent";
import { FolderPicker, RepoPicker } from "./NewProjectDialog";

/**
 * Module 11 (lane A): adds a repo to a project — a GitHub repo (cloned next to the project's other
 * clones on each agent's computer) or a folder on this Mac (asks for consent first, as New project does).
 */

const KINDS: { kind: ProjectRepoKind; label: string; hint: string }[] = [
  { kind: "github", label: "A GitHub repo", hint: "Yours, or any owner/name" },
  { kind: "folder", label: "A folder on this Mac", hint: "Used in place, with your OK" },
];

const GIT_URL = /^(?:https?:\/\/|git@|ssh:\/\/)/i;

export function AddRepoDialog({ project, open, onOpenChange }: { project: Project; open: boolean; onOpenChange: (open: boolean) => void }) {
  const projects = useProjects((s) => s.projects);
  // On the project's device (module 07), with that device's GitHub and folders.
  const device = project.deviceId ?? null;
  const localGithub = useStore((s) => s.github);
  const [remoteGithub, setRemoteGithub] = useState<GitHubStatus | null>(null);
  useEffect(() => {
    setRemoteGithub(null);
    if (!device || !open) return;
    onDevice(device, () => api.getGithubStatus()).then(setRemoteGithub, () => {});
  }, [device, open]);
  const githubLogin = (device ? remoteGithub : localGithub)?.connection?.login ?? null;

  const [kind, setKind] = useState<ProjectRepoKind>("github");
  const [repoQuery, setRepoQuery] = useState("");
  const [repo, setRepo] = useState<string | null>(null);
  const [folder, setFolder] = useState("");
  const [name, setName] = useState("");
  const [step, setStep] = useState<"form" | "consent">("form");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setKind("github");
    setRepoQuery("");
    setRepo(null);
    setFolder("");
    setName("");
    setStep("form");
    setSubmitting(false);
    setError(null);
  }, [open]);

  const typed = repoQuery.trim();
  const source = kind === "github" ? (repo ?? (isOwnerRepo(typed) || GIT_URL.test(typed) ? typed : "")) : folder.trim();
  const ownFolders = useMemo(() => (project.repos ?? []).filter((r) => r.kind === "folder").map((r) => r.source), [project.repos]);

  async function add() {
    if (!source || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await addProjectRepo(project.id, {
        kind,
        source,
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(kind === "folder" ? { grant: true } : {}),
      });
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
      setStep("form");
      setSubmitting(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!source) return;
    if (kind === "folder") setStep("consent");
    else void add();
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={step === "consent" ? folderConsentTitle(tildePath(folder.trim())) : `Add a repo to ${project.name}`}
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
            <Button variant="primary" autoFocus disabled={submitting} onClick={() => void add()}>
              {submitting ? "Allowing…" : "Allow"}
            </Button>
          </ModalFooter>
        </>
      ) : (
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <ModalBody className="space-y-5">
            <RadioGroup.Root
              value={kind}
              onValueChange={(value) => {
                setKind(value as ProjectRepoKind);
                setError(null);
              }}
              aria-label="What to add"
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
                      <span className="text-sm font-medium text-fg">{option.label}</span>
                      <span className="truncate text-xs text-fg-subtle">{option.hint}</span>
                    </span>
                  </RadioGroup.Item>
                );
              })}
            </RadioGroup.Root>

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
                <Field label="Repository" htmlFor="new-project-repo" hint="Type it as owner/name, or paste its URL.">
                  <input
                    id="new-project-repo"
                    value={repoQuery}
                    onChange={(event) => setRepoQuery(event.target.value)}
                    placeholder="acme/api"
                    autoFocus
                    autoComplete="off"
                    spellCheck={false}
                    className="input"
                  />
                </Field>
              ))}

            {kind === "folder" && <FolderPicker device={device} value={folder} onChange={setFolder} projects={projects} exclude={ownFolders} />}

            <Field label="Name" htmlFor="add-repo-name" hint="What tasks and the project's knowledge call it.">
              <input
                id="add-repo-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder={nameFromSource(source) || (kind === "github" ? "Filled in from the repo" : "Filled in from the folder")}
                maxLength={40}
                autoComplete="off"
                spellCheck={false}
                className="input"
              />
            </Field>

            {error && <Callout tone="danger">{error}</Callout>}
          </ModalBody>

          <ModalFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={!source || submitting}>
              {submitting ? "Adding…" : kind === "folder" ? "Continue" : "Add"}
            </Button>
          </ModalFooter>
        </form>
      )}
    </Modal>
  );
}
