import { useEffect, useState, type FormEvent } from "react";
import type { Project, SetupDetection } from "@tot/shared/types";
import { api, errorMessage } from "../../lib/api";
import { isCodeProject, parseList, PROJECT_ICONS, sourceLabel, tildePath, updateProject } from "../../lib/projects";
import { SettingRow } from "../settings/SettingRow";
import { Button } from "../ui/Button";
import { Callout } from "../ui/Callout";
import { Field } from "../ui/Field";
import { Modal, ModalBody, ModalFooter } from "../ui/Modal";
import { Switch } from "../ui/Switch";

type DialogProps = {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** Saves a patch, keeping the dialog open with the server's reason when it fails. */
function useSave(onOpenChange: (open: boolean) => void, open: boolean) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setSaving(false);
    setError(null);
  }, [open]);

  async function save(run: () => Promise<unknown>) {
    setSaving(true);
    setError(null);
    try {
      await run();
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }
  return { saving, error, save };
}

const MAX_INSTRUCTIONS = 4000;

/** The project's standing instructions: every chat in it follows them, whichever agent it's with. */
export function InstructionsDialog({ project, open, onOpenChange }: DialogProps) {
  const [text, setText] = useState(project.instructions);
  const { saving, error, save } = useSave(onOpenChange, open);
  useEffect(() => {
    if (open) setText(project.instructions);
  }, [open, project.instructions]);

  function submit(event: FormEvent) {
    event.preventDefault();
    void save(() => updateProject(project.id, { instructions: text }));
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Instructions"
      description={`Every chat in ${project.name} follows these, whichever agent it's with.`}
    >
      <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
        <ModalBody className="space-y-3">
          <label htmlFor="project-instructions" className="sr-only">
            Instructions for {project.name}
          </label>
          <textarea
            id="project-instructions"
            value={text}
            onChange={(event) => setText(event.target.value)}
            maxLength={MAX_INSTRUCTIONS}
            rows={8}
            autoFocus
            placeholder={
              project.kind === "none"
                ? "Audience is existing customers. Launch date is Nov 12."
                : "Use pnpm. Never touch billing/ without asking."
            }
            className="input min-h-40 resize-y rounded-xl leading-relaxed"
          />
          {error && <Callout tone="danger">{error}</Callout>}
        </ModalBody>
        <ModalFooter>
          <p className="mr-auto text-xs text-fg-subtle tabular-nums">
            {text.length > MAX_INSTRUCTIONS * 0.8 ? `${text.length} / ${MAX_INSTRUCTIONS}` : ""}
          </p>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={saving || text.trim() === project.instructions}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

/** Name, base branch, and intake (where its work comes from). The files themselves can't change. */
export function ProjectSettingsDialog({ project, open, onOpenChange }: DialogProps) {
  const [name, setName] = useState(project.name);
  const [branch, setBranch] = useState(project.defaultBranch ?? "");
  const [channels, setChannels] = useState("");
  const [teams, setTeams] = useState("");
  const { saving, error, save } = useSave(onOpenChange, open);
  const code = isCodeProject(project);
  const Icon = PROJECT_ICONS[project.kind];

  useEffect(() => {
    if (!open) return;
    setName(project.name);
    setBranch(project.defaultBranch ?? "");
    setChannels(project.intake.slackChannels.join(", "));
    setTeams(project.intake.linearTeams.join(", "));
  }, [open, project]);

  function submit(event: FormEvent) {
    event.preventDefault();
    void save(() =>
      updateProject(project.id, {
        name,
        ...(code ? { defaultBranch: branch.trim() || null } : {}),
        intake: { slackChannels: parseList(channels), linearTeams: parseList(teams) },
      }),
    );
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Project settings" className="max-w-md">
      <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
        <ModalBody className="space-y-5">
          <Field label="Name" htmlFor="project-name">
            <input
              id="project-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={60}
              autoFocus
              autoComplete="off"
              className="input"
            />
          </Field>

          <div className="space-y-1">
            <p className="text-sm font-medium text-fg">Files</p>
            <p className="flex min-w-0 items-center gap-2 text-sm text-fg-muted">
              <Icon aria-hidden="true" className="size-4 shrink-0" />
              <span className="truncate">{sourceLabel({ ...project, defaultBranch: null })}</span>
            </p>
            {code && <p className="text-xs leading-relaxed text-fg-subtle">Each agent works on its own copy, on tot/… branches.</p>}
          </div>

          {code && (
            <Field label="Base branch" htmlFor="project-branch" hint="Tasks branch from this. Leave it empty for the repo's default.">
              <input
                id="project-branch"
                value={branch}
                onChange={(event) => setBranch(event.target.value)}
                placeholder="The repo's default"
                autoComplete="off"
                spellCheck={false}
                className="input"
              />
            </Field>
          )}

          <div className="space-y-4 border-t border-hairline pt-5">
            <div>
              <h3 className="text-sm font-medium text-fg">Where its work comes from</h3>
              <p className="mt-0.5 text-xs leading-relaxed text-fg-subtle">
                Tickets from these start their chats in {project.name}. Separate them with commas.
              </p>
            </div>
            <IntakeFields channels={channels} teams={teams} onChannelsChange={setChannels} onTeamsChange={setTeams} />
          </div>

          {error && <Callout tone="danger">{error}</Callout>}
        </ModalBody>
        <ModalFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={saving || !name.trim()}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

/**
 * Where a project's work comes from (its intake, module 06): Slack channels and Linear teams, typed as comma lists
 * (parseList them to save). In Project settings, and in the Subscriptions dialog's tickets (module 12).
 */
export function IntakeFields({
  channels,
  teams,
  onChannelsChange,
  onTeamsChange,
  idPrefix = "project",
}: {
  channels: string;
  teams: string;
  onChannelsChange: (value: string) => void;
  onTeamsChange: (value: string) => void;
  idPrefix?: string;
}) {
  return (
    <>
      <Field label="Slack channels" htmlFor={`${idPrefix}-channels`}>
        <input
          id={`${idPrefix}-channels`}
          value={channels}
          onChange={(event) => onChannelsChange(event.target.value)}
          placeholder="#web-bugs, #web"
          autoComplete="off"
          spellCheck={false}
          className="input"
        />
      </Field>
      <Field label="Linear teams" htmlFor={`${idPrefix}-teams`}>
        <input
          id={`${idPrefix}-teams`}
          value={teams}
          onChange={(event) => onTeamsChange(event.target.value)}
          placeholder="ENG, WEB"
          autoComplete="off"
          spellCheck={false}
          className="input"
        />
      </Field>
    </>
  );
}

/** One path per line (or comma): the folder project's files to copy into each new worktree. */
const parseFiles = (text: string) =>
  text
    .split(/[\n,]+/)
    .map((line) => line.trim())
    .filter(Boolean);

/**
 * What every new task worktree in the project gets before its agent starts (module 09): a setup command
 * (empty: the one its lockfile implies, shown as the placeholder), and for a folder project, files copied
 * in from the folder, like .env.
 */
export function WorktreeSetupDialog({ project, open, onOpenChange }: DialogProps) {
  const [enabled, setEnabled] = useState(project.setupCommand !== "");
  const [command, setCommand] = useState(project.setupCommand ?? "");
  const [files, setFiles] = useState("");
  const [detected, setDetected] = useState<SetupDetection | null>(null);
  const { saving, error, save } = useSave(onOpenChange, open);
  const folder = project.kind === "folder";

  useEffect(() => {
    if (!open) return;
    setEnabled(project.setupCommand !== "");
    setCommand(project.setupCommand ?? "");
    setFiles((project.copyFiles ?? []).join("\n"));
  }, [open, project]);

  // What its lockfile implies: the command's placeholder.
  useEffect(() => {
    if (!open) return;
    let live = true;
    api
      .detectProjectSetup(project.id)
      .then((found) => live && setDetected(found))
      .catch(() => live && setDetected(null));
    return () => {
      live = false;
    };
  }, [open, project.id]);

  function submit(event: FormEvent) {
    event.preventDefault();
    void save(() =>
      updateProject(project.id, {
        setupCommand: enabled ? command.trim() || null : "",
        ...(folder ? { copyFiles: parseFiles(files) } : {}),
      }),
    );
  }

  const hint = detected?.command
    ? `Leave it empty to run ${detected.command}, from ${detected.lockfile}.`
    : "Leave it empty to run what each worktree's lockfile implies (npm ci for package-lock.json, uv sync for uv.lock…).";

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Worktree setup"
      description={`What every new task worktree in ${project.name} gets before its agent starts.`}
      className="max-w-md"
    >
      <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
        <ModalBody className="space-y-5">
          <div className="space-y-3">
            <SettingRow
              className="py-0"
              htmlFor="project-setup-on"
              title="Run a setup command"
              description="In the worktree, for up to 10 minutes. If it fails, the agent is told and starts anyway."
              control={<Switch id="project-setup-on" checked={enabled} onCheckedChange={setEnabled} />}
            />
            <Field label="Command" htmlFor="project-setup-command" hint={enabled ? hint : "Off: new worktrees start as they are."}>
              <input
                id="project-setup-command"
                value={enabled ? command : ""}
                onChange={(event) => setCommand(event.target.value)}
                disabled={!enabled}
                autoFocus
                maxLength={500}
                placeholder={enabled ? (detected?.command ?? "npm ci") : "Nothing"}
                autoComplete="off"
                spellCheck={false}
                className="input font-mono text-ui"
              />
            </Field>
          </div>

          {folder && (
            <div className="border-t border-hairline pt-5">
              <Field
                label="Files to copy"
                htmlFor="project-copy-files"
                hint={`Copied from ${tildePath(project.source ?? "")} into each new worktree, one path per line. TOT never shows what's in them.`}
              >
                <textarea
                  id="project-copy-files"
                  value={files}
                  onChange={(event) => setFiles(event.target.value)}
                  rows={3}
                  placeholder={".env\n.env.local"}
                  spellCheck={false}
                  className="input min-h-20 resize-y rounded-xl font-mono text-ui leading-relaxed"
                />
              </Field>
            </div>
          )}

          {error && <Callout tone="danger">{error}</Callout>}
        </ModalBody>
        <ModalFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
