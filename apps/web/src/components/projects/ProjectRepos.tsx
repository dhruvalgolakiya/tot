import { useEffect, useRef, useState, type FormEvent } from "react";
import { DropdownMenu } from "radix-ui";
import { Ellipsis, FolderGit, GraduationCap, Pencil, Plus, Star, Trash2 } from "lucide-react";
import type { Project, ProjectRepo } from "@tot/shared/types";
import { api, errorMessage } from "../../lib/api";
import { grantProjectRepo, removeProjectRepo, repoSourceLabel, updateProjectRepo } from "../../lib/project-repos";
import { PROJECT_ICONS, tildePath } from "../../lib/projects";
import { navigateToConversation, notifyError, selectActiveAgent, useStore } from "../../store";
import { ConfirmDialog } from "../ConfirmDialog";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Callout } from "../ui/Callout";
import { EmptyState } from "../ui/EmptyState";
import { Field } from "../ui/Field";
import { IconButton } from "../ui/IconButton";
import { Modal, ModalBody, ModalFooter } from "../ui/Modal";
import { AddRepoDialog } from "./AddRepoDialog";
import { FolderConsentText, folderConsentTitle } from "./FolderConsent";

/**
 * Module 11 (docs/roadmap/11-workspaces.md), lane A: the project's repos, the primary first, each a flat row
 * (its name, what it is, its base branch). Add one (a GitHub repo, or a folder on this Mac with consent);
 * a row's "…" menu learns it (its docs go under its own page in the project's knowledge), renames it or sets
 * its base branch, makes it the primary, or removes it (refused while a task has work in it). A folder not allowed yet shows "Allow…". Shown from the project menu's Repos.
 */
export function ProjectRepos({ project }: { project: Project }) {
  const repos = project.repos ?? [];
  const editable = !project.archived;
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ProjectRepo | null>(null);
  const [removing, setRemoving] = useState<ProjectRepo | null>(null);
  const [allowing, setAllowing] = useState<ProjectRepo | null>(null);
  const agent = useStore(selectActiveAgent);

  async function makePrimary(repo: ProjectRepo) {
    try {
      await updateProjectRepo(project.id, repo.name, { primary: true });
    } catch (error) {
      notifyError(error);
    }
  }

  async function learn(repo: ProjectRepo) {
    if (!agent) return;
    try {
      const { conversationId } = await api.learnProject(project.id, agent.id, repo.name);
      navigateToConversation(conversationId);
    } catch (error) {
      notifyError(error);
    }
  }

  async function remove(repo: ProjectRepo) {
    try {
      await removeProjectRepo(project.id, repo.name);
    } catch (error) {
      notifyError(error);
    }
  }

  // A paired device's TOT from before module 11 doesn't list a project's repos.
  if (!project.repos) {
    return <EmptyState variant="quiet" description="Update TOT on this project's device to work with several repos here." />;
  }

  return (
    <section aria-label="Repos" className="space-y-3">
      {repos.length > 0 && (
        <div className="flex items-center justify-between gap-4">
          <p className="min-w-0 text-xs leading-relaxed text-fg-subtle">
            {repos.length > 1 ? "Each task works in one repo. Tasks start in the primary unless you pick another." : "Tasks work in this repo. Add more to work across them."}
          </p>
          {editable && (
            <Button size="sm" className="shrink-0" onClick={() => setAdding(true)}>
              <Plus className="size-3.5" />
              Add repo
            </Button>
          )}
        </div>
      )}

      {repos.length === 0 ? (
        <EmptyState
          variant="quiet"
          icon={<FolderGit />}
          title="No repos yet"
          description="Add a GitHub repo or a folder on your Mac, and tasks in this project can work on its code."
          action={
            editable && (
              <Button size="sm" onClick={() => setAdding(true)}>
                <Plus className="size-3.5" />
                Add repo
              </Button>
            )
          }
        />
      ) : (
        <ul className="divide-y divide-hairline rounded-xl border border-hairline">
          {repos.map((repo) => (
            <RepoRow
              key={repo.name}
              repo={repo}
              editable={editable}
              onAllow={() => setAllowing(repo)}
              onLearn={agent && !(repo.kind === "folder" && !repo.folderGranted) ? () => void learn(repo) : undefined}
              onEdit={() => setEditing(repo)}
              onMakePrimary={() => void makePrimary(repo)}
              onRemove={() => setRemoving(repo)}
            />
          ))}
        </ul>
      )}

      <AddRepoDialog project={project} open={adding} onOpenChange={setAdding} />
      <EditRepoDialog project={project} repo={editing} onClose={() => setEditing(null)} />
      <AllowRepoDialog project={project} repo={allowing} onClose={() => setAllowing(null)} />
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
        title={`Remove ${removing?.name ?? "this repo"}?`}
        description={
          removing?.kind === "folder"
            ? `Tasks in ${project.name} won't work in it anymore, and agents lose access to ${tildePath(removing.source)}. The folder stays as it is.`
            : `Tasks in ${project.name} won't work in it anymore. Its clones stay where they are.`
        }
        confirmLabel="Remove"
        onConfirm={() => removing && void remove(removing)}
      />
    </section>
  );
}

function RepoRow({
  repo,
  editable,
  onAllow,
  onLearn,
  onEdit,
  onMakePrimary,
  onRemove,
}: {
  repo: ProjectRepo;
  editable: boolean;
  onAllow: () => void;
  /** Absent when it can't be learned now (no agent, or a folder not allowed yet). */
  onLearn?: () => void;
  onEdit: () => void;
  onMakePrimary: () => void;
  onRemove: () => void;
}) {
  const Icon = PROJECT_ICONS[repo.kind];
  const waiting = repo.kind === "folder" && !repo.folderGranted;
  const meta = [repoSourceLabel(repo), repo.defaultBranch, waiting ? "Not allowed yet" : null].filter(Boolean).join(" · ");
  // Menus open dialogs once they've closed: a closing Radix menu would take focus back from them.
  const pending = useRef<(() => void) | null>(null);

  return (
    <li className="group flex min-w-0 items-center gap-3 px-3 py-2.5">
      <Icon aria-hidden="true" className="size-4 shrink-0 text-fg-muted" />
      <div className="min-w-0 flex-1">
        <p className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium text-fg">{repo.name}</span>
          {repo.primary && <Badge>Primary</Badge>}
        </p>
        <p className="truncate text-xs text-fg-subtle" title={repo.source}>
          {meta}
        </p>
      </div>
      {waiting && editable && (
        <button type="button" onClick={onAllow} className="link-muted shrink-0 text-xs">
          Allow…
        </button>
      )}
      {editable && (
        <DropdownMenu.Root modal={false}>
          <DropdownMenu.Trigger asChild>
            <IconButton
              label={`${repo.name} options`}
              size="sm"
              className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 data-[state=open]:opacity-100"
            >
              <Ellipsis />
            </IconButton>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="end"
              sideOffset={4}
              className="menu w-48"
              onCloseAutoFocus={(event) => {
                const next = pending.current;
                pending.current = null;
                if (!next) return;
                event.preventDefault();
                next();
              }}
            >
              {onLearn && (
                <DropdownMenu.Item className="menu-item" onSelect={onLearn}>
                  <GraduationCap className="size-4 text-fg-muted" /> Learn this repo
                </DropdownMenu.Item>
              )}
              <DropdownMenu.Item className="menu-item" onSelect={() => (pending.current = onEdit)}>
                <Pencil className="size-4 text-fg-muted" /> Rename…
              </DropdownMenu.Item>
              {!repo.primary && (
                <DropdownMenu.Item className="menu-item" onSelect={onMakePrimary}>
                  <Star className="size-4 text-fg-muted" /> Make primary
                </DropdownMenu.Item>
              )}
              <DropdownMenu.Separator className="menu-separator" />
              <DropdownMenu.Item className="menu-item menu-item-danger" onSelect={() => (pending.current = onRemove)}>
                <Trash2 className="size-4" /> Remove…
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}
    </li>
  );
}

/** Its name (tasks follow; its clone stays where it is) and its base branch. */
function EditRepoDialog({ project, repo, onClose }: { project: Project; repo: ProjectRepo | null; onClose: () => void }) {
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!repo) return;
    setName(repo.name);
    setBranch(repo.defaultBranch ?? "");
    setSaving(false);
    setError(null);
  }, [repo]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!repo || saving) return;
    setSaving(true);
    setError(null);
    try {
      await updateProjectRepo(project.id, repo.name, {
        ...(name.trim() !== repo.name ? { name: name.trim() } : {}),
        defaultBranch: branch.trim() || null,
      });
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  return (
    <Modal open={repo !== null} onOpenChange={(open) => !open && onClose()} title={`Rename ${repo?.name ?? "repo"}`} className="max-w-md">
      <form onSubmit={save} className="flex min-h-0 flex-1 flex-col">
        <ModalBody className="space-y-4">
          <Field label="Name" htmlFor="repo-name" hint="What tasks and the project's knowledge call it. Its files stay where they are.">
            <input id="repo-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={40} autoFocus autoComplete="off" spellCheck={false} className="input" />
          </Field>
          <Field label="Base branch" htmlFor="repo-branch" hint="Where its tasks start, and what they merge into.">
            <input
              id="repo-branch"
              value={branch}
              onChange={(event) => setBranch(event.target.value)}
              placeholder="The repo's default"
              autoComplete="off"
              spellCheck={false}
              className="input font-mono text-ui"
            />
          </Field>
          {error && <Callout tone="danger">{error}</Callout>}
        </ModalBody>
        <ModalFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!name.trim() || saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

/** The consent dialog, for a folder repo added before the user said yes. */
function AllowRepoDialog({ project, repo, onClose }: { project: Project; repo: ProjectRepo | null; onClose: () => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setSaving(false);
    setError(null);
  }, [repo]);

  async function allow() {
    if (!repo) return;
    setSaving(true);
    setError(null);
    try {
      await grantProjectRepo(project.id, repo.name);
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  return (
    <Modal open={repo !== null} onOpenChange={(open) => !open && onClose()} title={folderConsentTitle(repo ? tildePath(repo.source) : "")} className="max-w-md">
      <ModalBody className="space-y-4 pb-2">
        <FolderConsentText />
        {error && <Callout tone="danger">{error}</Callout>}
      </ModalBody>
      <ModalFooter divider={false}>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" autoFocus disabled={saving} onClick={() => void allow()}>
          {saving ? "Allowing…" : "Allow"}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
