import { useEffect, useState, type FormEvent } from "react";
import type { Project } from "@shared/types";
import { errorMessage } from "../../lib/api";
import { isCodeProject, parseList, sourceLabel, updateProject } from "../../lib/projects";
import { Button } from "../ui/Button";
import { Callout } from "../ui/Callout";
import { Field } from "../ui/Field";
import { Modal, ModalBody, ModalFooter } from "../ui/Modal";

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
              autoComplete="off"
              className="input"
            />
          </Field>

          <Field label="Files" hint={code ? "Each agent works on its own copy, on tot/… branches." : undefined}>
            <p className="truncate rounded-lg bg-sunken px-3 py-2 text-sm text-fg-muted">{sourceLabel({ ...project, defaultBranch: null })}</p>
          </Field>

          {code && (
            <Field label="Base branch" htmlFor="project-branch" hint="Tasks start their branches from this. Leave it empty for the repo's default.">
              <input
                id="project-branch"
                value={branch}
                onChange={(event) => setBranch(event.target.value)}
                placeholder="The repo's default"
                autoComplete="off"
                spellCheck={false}
                className="input font-mono"
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
            <Field label="Slack channels" htmlFor="project-channels">
              <input
                id="project-channels"
                value={channels}
                onChange={(event) => setChannels(event.target.value)}
                placeholder="#web-bugs, #web"
                autoComplete="off"
                spellCheck={false}
                className="input"
              />
            </Field>
            <Field label="Linear teams" htmlFor="project-teams">
              <input
                id="project-teams"
                value={teams}
                onChange={(event) => setTeams(event.target.value)}
                placeholder="ENG, WEB"
                autoComplete="off"
                spellCheck={false}
                className="input"
              />
            </Field>
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
