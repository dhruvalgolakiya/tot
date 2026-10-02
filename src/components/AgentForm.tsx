import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import type { Agent, AgentInput, MascotSpec } from "@shared/types";
import { AUTO_MODEL_ID, modelSelectOptions } from "../lib/models";
import { createAgent, deleteAgent, goToSettings, setNewAgentDialogOpen, updateAgent, useStore } from "../store";
import { ConfirmDialog } from "./ConfirmDialog";
import { MascotPicker, randomMascot, suggestName } from "./mascot";
import { Button } from "./ui/Button";
import { Field } from "./ui/Field";
import { ModalBody, ModalFooter } from "./ui/Modal";
import { Select } from "./ui/Select";

/** Profile fields for a new agent (in the New agent dialog) or an existing one (in its settings panel). */
export function AgentForm({ target, canDelete }: { target: Agent | null; canDelete: boolean }) {
  const [mascot, setMascot] = useState<MascotSpec>(() => target?.mascot ?? randomMascot());
  const [name, setName] = useState(() => target?.name ?? suggestName(mascot));
  const [instructions, setInstructions] = useState(target?.instructions ?? "");
  const [modelId, setModelId] = useState(target?.modelId ?? AUTO_MODEL_ID);
  const [personaId, setPersonaId] = useState<string | null>(target?.personaId ?? null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const models = useStore((s) => s.models);
  const personas = useStore((s) => s.personas);
  const trimmedName = name.trim();

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!trimmedName || saving) return;
    setSaving(true);
    const input: AgentInput = { name: trimmedName, mascot, instructions: instructions.trim(), modelId, personaId };
    if (target) {
      if (await updateAgent(target.id, input)) toast.success("Saved");
    } else {
      await createAgent(input);
    }
    setSaving(false);
  }

  async function onDelete() {
    if (!target) return;
    setDeleting(true);
    const ok = await deleteAgent(target.id);
    if (!ok) setDeleting(false);
  }

  return (
    <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
      <ModalBody className="space-y-5">
        <Field label="Name" htmlFor="agent-name">
          <input
            id="agent-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Scout"
            maxLength={40}
            autoFocus={!target}
            autoComplete="off"
            className="input h-10 rounded-xl"
          />
        </Field>

        <Field label="Mascot">
          <MascotPicker value={mascot} onChange={setMascot} />
        </Field>

        <Field
          label="Works as"
          htmlFor="agent-persona"
          hint={
            <>
              Gives it its own email, git author and GitHub account instead of yours.{" "}
              <button type="button" onClick={() => goToSettings("personas")} className="link-muted">
                Manage personas
              </button>
            </>
          }
        >
          <Select
            id="agent-persona"
            value={personaId ?? ""}
            onValueChange={(next) => setPersonaId(next || null)}
            className="h-10 rounded-xl"
            options={[
              { value: "", label: "Me" },
              ...personas.map((persona) => ({ value: persona.id, label: `${persona.name} · ${persona.email}` })),
            ]}
          />
        </Field>

        <Field
          label="Instructions"
          htmlFor="agent-instructions"
          hint="Personality and standing instructions, added to every chat with this agent."
        >
          <textarea
            id="agent-instructions"
            rows={4}
            value={instructions}
            onChange={(event) => setInstructions(event.target.value)}
            placeholder="e.g. You're upbeat and concise. Prefer getting things done on the computer over just describing how."
            className="input min-h-24 resize-y rounded-xl leading-relaxed"
          />
        </Field>

        <Field label="Default model" htmlFor="agent-model" hint="New chats with this agent start here.">
          <Select
            id="agent-model"
            value={modelId}
            onValueChange={setModelId}
            className="h-10 rounded-xl"
            options={modelSelectOptions(models, modelId)}
          />
        </Field>
      </ModalBody>

      <ModalFooter>
        {target && (
          <Button
            type="button"
            variant="ghost-danger"
            className="mr-auto"
            disabled={!canDelete || deleting}
            title={canDelete ? undefined : "You need at least one agent"}
            onClick={() => setConfirmingDelete(true)}
          >
            Delete
          </Button>
        )}
        {!target && (
          <Button type="button" variant="ghost" onClick={() => setNewAgentDialogOpen(false)}>
            Cancel
          </Button>
        )}
        <Button type="submit" variant="primary" disabled={!trimmedName || saving}>
          {saving ? "Saving…" : target ? "Save changes" : "Create agent"}
        </Button>
      </ModalFooter>

      {target && (
        <ConfirmDialog
          open={confirmingDelete}
          onOpenChange={setConfirmingDelete}
          title="Delete agent"
          description={
            <>
              This deletes <span className="font-medium text-fg">{target.name}</span> and all of its chats. This
              can't be undone.
            </>
          }
          confirmLabel={deleting ? "Deleting…" : "Delete"}
          onConfirm={() => void onDelete()}
        />
      )}
    </form>
  );
}
