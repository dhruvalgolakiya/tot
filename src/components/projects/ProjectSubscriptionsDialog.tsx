import { useEffect, useState } from "react";
import { DropdownMenu } from "radix-ui";
import { Ellipsis, Pencil, Plus, Trash } from "lucide-react";
import type { GitHubStatus, Project, PullRequestWatch, Routine, RoutineInput } from "@shared/types";
import { api, errorMessage } from "../../lib/api";
import { onDevice } from "../../lib/devices";
import { parseList, updateProject } from "../../lib/projects";
import { goToSettings, notifyError, useStore } from "../../store";
import { formatRelative, formatSchedule, RoutineForm, type RoutineFormValues } from "../routines";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Callout } from "../ui/Callout";
import { EmptyState } from "../ui/EmptyState";
import { GitHubMark } from "../ui/GitHubMark";
import { IconButton } from "../ui/IconButton";
import { Modal, ModalBody, ModalFooter } from "../ui/Modal";
import { Select } from "../ui/Select";
import { Skeleton } from "../ui/Skeleton";
import { Switch } from "../ui/Switch";
import { IntakeFields } from "./ProjectDialogs";

/**
 * Module 12, lane B: what the project's Lead hears about on its own, and when it checks in (… menu → Subscriptions).
 * Pull requests (Off / TOT's PRs / All PRs, through lane A's subscriptions routes; "Connect GitHub" without a
 * connection), its tickets (module 06's intake: Slack channels, Linear teams), and its schedules (list, add, edit,
 * pause, delete), which wake the Lead with their prompt instead of starting chats. Adding or editing a schedule
 * swaps the dialog's body for the routine form.
 */

type Props = { project: Project; open: boolean; onOpenChange: (open: boolean) => void };

const WATCH: { value: PullRequestWatch; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "tot", label: "TOT's PRs" },
  { value: "all", label: "All PRs" },
];

/** The empty list's one example. */
const EXAMPLE: Partial<RoutineFormValues> = {
  name: "What's stuck?",
  prompt: "Look at the board and tell me what's stuck, what needs me, and what's ready to land.",
  scheduleKind: "daily",
  time: "09:00",
  days: [1, 2, 3, 4, 5],
};

type Editing = { routine: Routine | null; prefill?: Partial<RoutineFormValues> } | null;

export function ProjectSubscriptionsDialog({ project, open, onOpenChange }: Props) {
  const [editing, setEditing] = useState<Editing>(null);
  const [schedules, setSchedules] = useState<Routine[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  function load() {
    setLoadError(null);
    api.listProjectSchedules(project.id).then(setSchedules, (error: unknown) => setLoadError(errorMessage(error)));
  }

  useEffect(() => {
    if (!open) return;
    setEditing(null);
    setSchedules(null);
    load();
    // Fresh each time it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, project.id]);

  const replace = (routine: Routine) =>
    setSchedules((list) => (list ? (list.some((r) => r.id === routine.id) ? list.map((r) => (r.id === routine.id ? routine : r)) : [...list, routine]) : list));

  function save(input: RoutineInput): Promise<Routine> {
    return editing?.routine ? api.updateProjectSchedule(project.id, editing.routine.id, input) : api.createProjectSchedule(project.id, input);
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={editing ? (editing.routine ? "Edit schedule" : "New schedule") : "Subscriptions"}
      description={editing ? undefined : `What the Lead of ${project.name} hears about on its own, and when it checks in.`}
      className="max-w-lg"
    >
      {editing ? (
        <ModalBody>
          <RoutineForm
            routine={editing.routine ?? undefined}
            initialValues={editing.prefill}
            onSubmit={save}
            noun="schedule"
            promptHint="What the Lead does each time. It hears this in its chat and acts on it."
            placeholders={{ name: "What's stuck?", prompt: "Look at the board and tell me what's stuck and what needs me." }}
            onSaved={(routine) => {
              replace(routine);
              setEditing(null);
            }}
            onCancel={() => setEditing(null)}
          />
        </ModalBody>
      ) : (
        <>
          <ModalBody className="space-y-6">
            <PullRequests project={project} open={open} onConnect={() => onOpenChange(false)} />
            <Tickets project={project} open={open} />
            <section className="space-y-3 border-t border-hairline pt-5">
              <div>
                <h3 className="text-sm font-medium text-fg">Schedules</h3>
                <p className="mt-0.5 text-xs leading-relaxed text-fg-subtle">At its time, each one wakes the Lead with its prompt.</p>
              </div>
              {loadError && (
                <Callout tone="danger" action={<button type="button" onClick={load} className="link-muted">Try again</button>}>
                  Couldn't load the schedules. {loadError}
                </Callout>
              )}
              {!schedules && !loadError && (
                <div className="space-y-2" aria-busy="true" aria-label="Loading schedules">
                  <Skeleton className="h-14 rounded-xl" />
                </div>
              )}
              {schedules?.length === 0 && (
                <EmptyState
                  variant="dashed"
                  size="sm"
                  description="Nothing scheduled. For example, every weekday at 9:00: what's stuck?"
                  action={
                    <div className="flex flex-wrap justify-center gap-2">
                      <Button size="sm" onClick={() => setEditing({ routine: null, prefill: EXAMPLE })}>
                        Use this example
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditing({ routine: null })}>
                        <Plus /> Add schedule
                      </Button>
                    </div>
                  }
                />
              )}
              {schedules && schedules.length > 0 && (
                <>
                  <ul className="divide-y divide-hairline rounded-xl border border-hairline">
                    {schedules.map((routine) => (
                      <ScheduleRow
                        key={routine.id}
                        project={project}
                        routine={routine}
                        onChanged={replace}
                        onDeleted={(id) => setSchedules((list) => list?.filter((r) => r.id !== id) ?? null)}
                        onEdit={() => setEditing({ routine })}
                      />
                    ))}
                  </ul>
                  <Button size="sm" variant="ghost" onClick={() => setEditing({ routine: null })}>
                    <Plus /> Add schedule
                  </Button>
                </>
              )}
            </section>
          </ModalBody>
          <ModalFooter>
            <Button variant="primary" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </ModalFooter>
        </>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Pull requests: which ones the Lead watches (lane A's watcher reads them, never writes)
// ---------------------------------------------------------------------------

function PullRequests({ project, open, onConnect }: { project: Project; open: boolean; onConnect: () => void }) {
  const device = project.deviceId ?? null;
  const localGithub = useStore((s) => s.github);
  const [remoteGithub, setRemoteGithub] = useState<GitHubStatus | null>(null);
  const [watch, setWatch] = useState<PullRequestWatch>(project.subscriptions?.pullRequests ?? "tot");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setWatch(project.subscriptions?.pullRequests ?? "tot");
    let live = true;
    // The project's own record is enough to show; this only catches up when it's newer.
    api.getProjectSubscriptions(project.id).then((found) => live && found?.pullRequests && setWatch(found.pullRequests), () => {});
    if (device) onDevice(device, () => api.getGithubStatus()).then((status) => live && setRemoteGithub(status), () => {});
    return () => {
      live = false;
    };
  }, [open, project.id, device]);

  const github = device ? remoteGithub : localGithub;
  const connected = Boolean(github?.connection);
  const hasGithubRepo = project.kind === "github" || (project.repos ?? []).some((repo) => repo.kind === "github");

  async function change(next: PullRequestWatch) {
    const before = watch;
    setWatch(next);
    setSaving(true);
    setError(null);
    try {
      setWatch((await api.updateProjectSubscriptions(project.id, { pullRequests: next })).pullRequests);
    } catch (err) {
      setWatch(before);
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="space-y-2.5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p id="subscriptions-prs" className="text-sm font-medium text-fg">
            Pull requests
          </p>
          <p className="mt-0.5 text-xs leading-relaxed text-fg-subtle">
            {hasGithubRepo
              ? "Checks failing or passing, reviews asking for changes, comments, merges and conflicts. TOT only reads them."
              : "This project has no GitHub repos to watch."}
          </p>
        </div>
        {hasGithubRepo && (
          <Select
            aria-labelledby="subscriptions-prs"
            size="sm"
            value={watch}
            onValueChange={(value) => void change(value as PullRequestWatch)}
            options={WATCH}
            disabled={saving}
            className="w-32 shrink-0"
          />
        )}
      </div>
      {hasGithubRepo && github && !connected && (
        <p className="flex items-center gap-2 rounded-xl border border-hairline px-3 py-2.5 text-xs text-fg-muted">
          <GitHubMark className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">No GitHub connection, so no pull request news yet.</span>
          <button
            type="button"
            className="link-muted shrink-0"
            onClick={() => {
              onConnect();
              goToSettings("github");
            }}
          >
            Connect GitHub
          </button>
        </p>
      )}
      {error && <Callout tone="danger">{error}</Callout>}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Tickets: the project's intake (module 06), which goes to the Lead
// ---------------------------------------------------------------------------

function Tickets({ project, open }: { project: Project; open: boolean }) {
  const [editing, setEditing] = useState(false);
  const [channels, setChannels] = useState("");
  const [teams, setTeams] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) setEditing(false);
  }, [open]);

  function edit() {
    setChannels(project.intake.slackChannels.join(", "));
    setTeams(project.intake.linearTeams.join(", "));
    setError(null);
    setEditing(true);
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await updateProject(project.id, { intake: { slackChannels: parseList(channels), linearTeams: parseList(teams) } });
      setEditing(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const githubRepos = (project.repos ?? []).filter((repo) => repo.kind === "github").map((repo) => repo.source);
  const sources = [
    ...project.intake.slackChannels,
    ...project.intake.linearTeams.map((team) => `Linear ${team}`),
    ...githubRepos.map((repo) => `${repo} issues`),
  ];

  return (
    <section className="space-y-3 border-t border-hairline pt-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-fg">Tickets</h3>
          <p className="mt-0.5 text-xs leading-relaxed text-fg-subtle">
            {sources.length ? `From ${sources.join(", ")}.` : "From the Slack channels and Linear teams you list here."}
          </p>
        </div>
        {!editing && (
          <Button size="sm" variant="ghost" onClick={edit} className="shrink-0">
            Edit
          </Button>
        )}
      </div>
      {editing && (
        <div className="space-y-4" data-escape-cancels>
          <IntakeFields channels={channels} teams={teams} onChannelsChange={setChannels} onTeamsChange={setTeams} idPrefix="subscriptions" />
          <p className="text-xs leading-relaxed text-fg-subtle">Separate them with commas. Its GitHub repos' issues always count.</p>
          {error && <Callout tone="danger">{error}</Callout>}
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => void save()} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Schedules: one row each, with its pause switch and a menu (Edit, Delete)
// ---------------------------------------------------------------------------

function ScheduleRow({
  project,
  routine,
  onChanged,
  onDeleted,
  onEdit,
}: {
  project: Project;
  routine: Routine;
  onChanged: (routine: Routine) => void;
  onDeleted: (id: string) => void;
  onEdit: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function setEnabled(enabled: boolean) {
    setBusy(true);
    onChanged({ ...routine, enabled });
    try {
      onChanged(await api.updateProjectSchedule(project.id, routine.id, { enabled }));
    } catch (error) {
      onChanged(routine);
      notifyError(error);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api.deleteProjectSchedule(project.id, routine.id);
      onDeleted(routine.id);
    } catch (error) {
      notifyError(error);
      setBusy(false);
    }
  }

  const when = routine.enabled && routine.nextRunAt ? `next ${formatRelative(routine.nextRunAt)}` : null;

  return (
    <li className="px-3 py-2.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-sm font-medium text-fg">{routine.name}</span>
            {!routine.enabled && <Badge>Paused</Badge>}
          </div>
          <p className="mt-0.5 truncate text-xs text-fg-subtle">
            {formatSchedule(routine.schedule)}
            {when ? ` · ${when}` : ""}
          </p>
        </div>
        <Switch
          checked={routine.enabled}
          onCheckedChange={(enabled) => void setEnabled(enabled)}
          disabled={busy}
          label={`${routine.enabled ? "Pause" : "Resume"} ${routine.name}`}
        />
        <DropdownMenu.Root modal={false}>
          <DropdownMenu.Trigger asChild>
            <IconButton label={`Actions for ${routine.name}`} size="sm" disabled={busy}>
              <Ellipsis />
            </IconButton>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="end" sideOffset={4} className="menu w-44">
              <DropdownMenu.Item className="menu-item" onSelect={onEdit}>
                <Pencil className="size-4 text-fg-muted" /> Edit
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="menu-separator" />
              <DropdownMenu.Item className="menu-item menu-item-danger" onSelect={() => setConfirming(true)}>
                <Trash className="size-4" /> Delete
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
      {confirming && (
        <div className="mt-2.5 flex items-center justify-end gap-2 border-t border-hairline pt-2.5">
          <span className="mr-auto text-xs text-fg-muted">Delete this schedule?</span>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" variant="danger" onClick={() => void remove()} disabled={busy}>
            Delete
          </Button>
        </div>
      )}
    </li>
  );
}
