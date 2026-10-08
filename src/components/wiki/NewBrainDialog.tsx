import { useEffect, useState, type FormEvent } from "react";
import type { Agent, Brain } from "@shared/types";
import { api, errorMessage } from "../../lib/api";
import { upsertBrain } from "../../store";
import { Button } from "../ui/Button";
import { Callout } from "../ui/Callout";
import { Field } from "../ui/Field";
import { Modal, ModalBody, ModalFooter } from "../ui/Modal";

type NewBrainDialogProps = {
  agent: Agent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (brain: Brain) => void;
  onLearnRepo: () => void;
};

/** A shared brain for a client, product or topic, attached to this agent; repos come from "Learn a repo". */
export function NewBrainDialog({ agent, open, onOpenChange, onCreated, onLearnRepo }: NewBrainDialogProps) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [keywords, setKeywords] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setDescription("");
    setKeywords("");
    setError(null);
    setSaving(false);
  }, [open]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const brain = await api.createBrain({
        name,
        description,
        keywords: keywords.split(",").map((word) => word.trim()).filter(Boolean),
        agentId: agent.id,
      });
      upsertBrain(brain);
      onOpenChange(false);
      onCreated(brain);
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="New knowledge base"
      description={`A shared knowledge base for one client, product or topic. ${agent.name} can read and write it; attach more agents in its settings.`}
    >
      <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
        <ModalBody className="space-y-4">
          <Field label="Name" htmlFor="new-brain-name">
            <input
              id="new-brain-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Acme client"
              autoFocus
              maxLength={80}
              className="input h-10 rounded-xl"
            />
          </Field>
          <Field label="What it knows" htmlFor="new-brain-description" hint="One line on its card, so agents know when to use it.">
            <input
              id="new-brain-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Acme: contacts, contracts, their stack and open requests"
              maxLength={300}
              className="input h-10 rounded-xl"
            />
          </Field>
          <Field
            label="Keywords"
            htmlFor="new-brain-keywords"
            hint="Comma-separated. When a message mentions one, agents are shown its Overview."
          >
            <input
              id="new-brain-keywords"
              value={keywords}
              onChange={(e) => setKeywords(e.target.value)}
              placeholder="e.g. acme, acme corp"
              className="input h-10 rounded-xl"
            />
          </Field>
          <p className="text-xs text-fg-subtle">
            For a codebase,{" "}
            <button
              type="button"
              className="link-muted"
              onClick={() => {
                onOpenChange(false);
                onLearnRepo();
              }}
            >
              learn a repo
            </button>{" "}
            instead — {agent.name} studies it and writes it up for you.
          </p>
          {error && <Callout tone="danger">{error}</Callout>}
        </ModalBody>
        <ModalFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!name.trim() || saving}>
            {saving ? "Creating…" : "Create"}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
