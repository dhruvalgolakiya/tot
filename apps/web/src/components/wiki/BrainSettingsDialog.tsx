import { useEffect, useState, type FormEvent } from "react";
import type { Agent, Brain, BrainAccess } from "@shared/types";
import { api, errorMessage } from "../../lib/api";
import { brainName } from "../../lib/brains";
import { upsertBrain } from "../../store";
import { ConfirmDialog } from "../ConfirmDialog";
import { Button } from "../ui/Button";
import { Callout } from "../ui/Callout";
import { Field } from "../ui/Field";
import { Modal, ModalBody, ModalFooter } from "../ui/Modal";
import { Select } from "../ui/Select";
import { Switch } from "../ui/Switch";

type Choice = BrainAccess | "none";

type BrainSettingsDialogProps = {
  brain: Brain;
  agents: Agent[];
  /** The agent whose wiki is open, so "Notebook" reads right. */
  viewerAgentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
};

const splitKeywords = (text: string) =>
  text
    .split(",")
    .map((word) => word.trim())
    .filter(Boolean);

/** Name, card and keywords of a brain, and which agents may read or write it. */
export function BrainSettingsDialog({ brain, agents, viewerAgentId, open, onOpenChange, onDeleted }: BrainSettingsDialogProps) {
  const notebook = brain.kind === "notebook";
  const [name, setName] = useState(brain.name);
  const [description, setDescription] = useState(brain.description);
  const [keywords, setKeywords] = useState(brain.keywords.join(", "));
  const [allAgents, setAllAgents] = useState(brain.allAgents);
  const [access, setAccess] = useState<Record<string, Choice>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(brain.name);
    setDescription(brain.description);
    setKeywords(brain.keywords.join(", "));
    setAllAgents(brain.allAgents);
    setAccess(Object.fromEntries(agents.map((agent) => [agent.id, brain.agents.find((a) => a.agentId === agent.id)?.access ?? "none"])));
    setError(null);
    setSaving(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when (re)opened or another brain is shown
  }, [open, brain.id]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      let saved = await api.updateBrain(brain.id, {
        description,
        keywords: splitKeywords(keywords),
        ...(notebook ? {} : { name, allAgents }),
      });
      if (!notebook) {
        for (const agent of agents) {
          const before = brain.agents.find((a) => a.agentId === agent.id)?.access ?? "none";
          const after = access[agent.id] ?? "none";
          if (after === before) continue;
          saved = after === "none" ? await api.removeBrainAccess(brain.id, agent.id) : await api.setBrainAccess(brain.id, agent.id, after);
        }
      }
      upsertBrain(saved);
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  async function remove() {
    try {
      await api.deleteBrain(brain.id);
      onOpenChange(false);
      onDeleted();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  const owner = agents.find((agent) => agent.id === brain.ownerAgentId);

  return (
    <>
      <Modal
        open={open}
        onOpenChange={onOpenChange}
        title={`${brainName(brain, agents, viewerAgentId)} settings`}
        description={
          notebook
            ? `${owner?.name ?? "This agent"}'s private notebook: what it knows about this workspace and anything no shared knowledge covers.`
            : "Shared knowledge: one repo, client or topic that any agent you attach can use."
        }
      >
        <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
          <ModalBody className="space-y-5">
            {!notebook && (
              <Field label="Name" htmlFor="brain-name" hint="Agents see this name, and @name in a message points them to the brain.">
                <input id="brain-name" value={name} onChange={(e) => setName(e.target.value)} className="input h-10 rounded-xl" maxLength={80} />
              </Field>
            )}
            <Field
              label="What it knows"
              htmlFor="brain-description"
              hint="One line on its card, so agents know when to use it."
            >
              <input
                id="brain-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={notebook ? "e.g. Acme's storefront work, deploys and on-call notes" : "e.g. The storefront: Next.js app, checkout and payments"}
                className="input h-10 rounded-xl"
                maxLength={300}
              />
            </Field>
            <Field
              label="Keywords"
              htmlFor="brain-keywords"
              hint={
                notebook
                  ? "Comma-separated. Shown on its card."
                  : "Comma-separated. When a message mentions one, agents are shown its Overview. Repo knowledge also matches their repo's name, URL and folder."
              }
            >
              <input
                id="brain-keywords"
                value={keywords}
                onChange={(e) => setKeywords(e.target.value)}
                placeholder="e.g. storefront, checkout, payments"
                className="input h-10 rounded-xl"
              />
            </Field>
            {brain.source && (
              <p className="text-xs text-fg-subtle">
                Learned from <span className="font-medium text-fg-muted">{brain.source}</span>. Learn it again to bring it up to date.
              </p>
            )}

            {!notebook && (
              <section className="space-y-2">
                <div className="flex items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-medium text-fg">All agents</h3>
                    <p className="text-xs text-fg-subtle">Every agent, including new ones, can read and write it.</p>
                  </div>
                  <Switch checked={allAgents} onCheckedChange={setAllAgents} label="All agents" />
                </div>
                {!allAgents && (
                  <ul className="divide-y divide-hairline rounded-xl border border-hairline">
                    {agents.map((agent) => (
                      <li key={agent.id} className="flex items-center gap-3 px-3 py-2">
                        <span className="min-w-0 flex-1 truncate text-sm text-fg">{agent.name}</span>
                        <Select
                          aria-label={`${agent.name}'s access`}
                          value={access[agent.id] ?? "none"}
                          onValueChange={(next) => setAccess((current) => ({ ...current, [agent.id]: next as Choice }))}
                          size="sm"
                          className="w-40 rounded-lg"
                          options={[
                            { value: "none", label: "No access" },
                            { value: "read", label: "Can read" },
                            { value: "write", label: "Can read & write" },
                          ]}
                        />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            )}

            {error && <Callout tone="danger">{error}</Callout>}
          </ModalBody>

          <ModalFooter>
            {!notebook && (
              <Button type="button" variant="ghost-danger" className="mr-auto" onClick={() => setConfirmDelete(true)}>
                Delete
              </Button>
            )}
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={saving || (!notebook && !name.trim())}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </ModalFooter>
        </form>
      </Modal>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${brain.name}?`}
        description={`Its ${brain.pageCount} pages disappear for every agent that uses it.`}
        confirmLabel="Delete"
        onConfirm={() => void remove()}
      />
    </>
  );
}
