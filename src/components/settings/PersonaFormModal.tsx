import { useEffect, useState, type FormEvent } from "react";
import type { Persona } from "@shared/types";
import { api, errorMessage } from "../../lib/api";
import { isValidEmail } from "../../lib/personas";
import { setPersona } from "../../store";
import { Button } from "../ui/Button";
import { Callout } from "../ui/Callout";
import { Field } from "../ui/Field";
import { Modal, ModalBody, ModalFooter } from "../ui/Modal";

type PersonaFormModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Null creates a new persona; otherwise edits its name/email ("Rename / Change email"). */
  persona: Persona | null;
  /** Fires after a successful create, with the new persona. */
  onCreated?: (persona: Persona) => void;
};

/** "New persona" and "Rename / Change email" share the same two fields. */
export function PersonaFormModal({ open, onOpenChange, persona, onCreated }: PersonaFormModalProps) {
  const [name, setName] = useState(persona?.name ?? "");
  const [email, setEmail] = useState(persona?.email ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset to the target's current values (or blank for create) each time the modal opens. Keyed on
  // the id, not the whole object, so a live store update to this same persona (e.g. a `mail` event
  // bumping its unread count) while the modal is open doesn't clobber what the user is typing.
  useEffect(() => {
    if (!open) return;
    setName(persona?.name ?? "");
    setEmail(persona?.email ?? "");
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally excludes `persona`'s fields, see above
  }, [open, persona?.id]);

  const trimmedName = name.trim();
  const trimmedEmail = email.trim();
  const canSave = trimmedName.length > 0 && isValidEmail(trimmedEmail) && !saving;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const result = persona
        ? await api.updatePersona(persona.id, { name: trimmedName, email: trimmedEmail })
        : await api.createPersona({ name: trimmedName, email: trimmedEmail });
      setPersona(result);
      onOpenChange(false);
      if (!persona) onCreated?.(result);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={persona ? "Rename persona" : "New persona"} className="max-w-sm">
      <form onSubmit={(event) => void submit(event)}>
        <ModalBody className="space-y-4">
          {!persona && (
            <p className="text-sm leading-relaxed text-fg-muted">
              Give an agent its own email so its sign-ups, emails and commits show up as the agent, not you.
            </p>
          )}
          <Field label="Name" htmlFor="persona-name" hint="Shown as the sender name and the git author.">
            <input
              id="persona-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Scout"
              maxLength={60}
              autoFocus
              autoComplete="off"
              className="input h-10 rounded-xl"
            />
          </Field>
          <Field label="Email" htmlFor="persona-email" hint="A real mailbox, e.g. a free Gmail account made for the agent.">
            <input
              id="persona-email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="scout.agent@gmail.com"
              autoComplete="off"
              spellCheck={false}
              className="input h-10 rounded-xl"
            />
          </Field>
          {error && <Callout tone="danger">{error}</Callout>}
        </ModalBody>
        <ModalFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!canSave}>
            {saving ? "Saving…" : persona ? "Save changes" : "Create persona"}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
