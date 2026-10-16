import { useEffect, useState, type FormEvent } from "react";
import { DropdownMenu } from "radix-ui";
import { ArrowDown, ArrowUp, Check, Plus, Trash } from "lucide-react";
import type { GateName, PlaybookInput, PlaybookStep, PlaybookStepKind } from "@shared/types";
import { errorMessage } from "../../lib/api";
import { Button } from "../ui/Button";
import { Callout } from "../ui/Callout";
import { cardClass } from "../ui/Card";
import { Field } from "../ui/Field";
import { IconButton } from "../ui/IconButton";
import { Modal, ModalBody, ModalFooter } from "../ui/Modal";
import { Select } from "../ui/Select";
import { Tip } from "../ui/Tip";
import { GATE_LABELS } from "./GateReportView";
import { ChipInput } from "./ListEditors";

export const STEP_LABELS: Record<PlaybookStepKind, string> = {
  understand: "Understand",
  reproduce: "Reproduce",
  plan: "Plan",
  "approve-plan": "Approve plan",
  implement: "Implement",
  verify: "Verify",
  review: "Review",
  "fix-loop": "Fix loop",
  summarize: "Summarize",
  custom: "Custom",
};

const STEP_KINDS = Object.keys(STEP_LABELS) as PlaybookStepKind[];
const GATES = Object.keys(GATE_LABELS) as GateName[];

type PlaybookEditorProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  initial: PlaybookInput;
  /** Instructions to start a new step of each kind with (from the built-ins). */
  templates: Partial<Record<PlaybookStepKind, string>>;
  onSave: (input: PlaybookInput) => Promise<void>;
};

/** A custom playbook: name, when it's picked (match hints), and its steps in order. */
export function PlaybookEditor({ open, onOpenChange, title, initial, templates, onSave }: PlaybookEditorProps) {
  const [form, setForm] = useState<PlaybookInput>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setForm(initial);
    setSaving(false);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reset only when (re)opened
  }, [open]);

  const setSteps = (steps: PlaybookStep[]) => setForm((current) => ({ ...current, steps }));
  const updateStep = (index: number, patch: Partial<PlaybookStep>) => setSteps(form.steps.map((step, i) => (i === index ? { ...step, ...patch } : step)));
  const move = (index: number, by: number) => {
    const steps = [...form.steps];
    const [moved] = steps.splice(index, 1);
    steps.splice(index + by, 0, moved);
    setSteps(steps);
  };

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(form);
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={title} description="Its steps become a coding task's checklist, each followed by the checks you pick." className="flex max-w-xl flex-col">
      <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
        <ModalBody className="space-y-5">
          <Field label="Name" htmlFor="playbook-name">
            <input id="playbook-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={60} className="input h-10 rounded-xl" />
          </Field>
          <Field label="Description" htmlFor="playbook-description">
            <input
              id="playbook-description"
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              maxLength={300}
              placeholder="One line on when to use it"
              className="input h-10 rounded-xl"
            />
          </Field>
          <Field label="Match hints" hint="Words in a task that point to this playbook, like “hotfix” or “outage”.">
            <ChipInput label="Match hints" values={form.match} onChange={(match) => setForm({ ...form, match })} placeholder="Add a word, then press Enter" />
          </Field>

          <section className="space-y-2">
            <h3 className="text-sm font-medium text-fg">Steps</h3>
            <ol className="space-y-2">
              {form.steps.map((step, index) => (
                <li key={index} className={cardClass({ padding: "sm", className: "space-y-2" })}>
                  <div className="flex items-center gap-2">
                    <span className="w-5 shrink-0 text-center text-xs text-fg-subtle tabular-nums">{index + 1}</span>
                    <Select
                      aria-label={`Step ${index + 1} kind`}
                      size="sm"
                      value={step.kind}
                      onValueChange={(value) => {
                        const kind = value as PlaybookStepKind;
                        // Untouched instructions follow the kind; written ones stay.
                        const untouched = !step.instructions.trim() || step.instructions === templates[step.kind];
                        updateStep(index, {
                          kind,
                          instructions: untouched ? (templates[kind] ?? step.instructions) : step.instructions,
                          maxRounds: kind === "fix-loop" ? step.maxRounds : undefined,
                        });
                      }}
                      options={STEP_KINDS.map((kind) => ({ value: kind, label: STEP_LABELS[kind] }))}
                      className="w-40 rounded-lg"
                    />
                    <span className="ml-auto flex items-center">
                      <IconButton label={`Move step ${index + 1} up`} size="sm" disabled={index === 0} onClick={() => move(index, -1)}>
                        <ArrowUp />
                      </IconButton>
                      <IconButton label={`Move step ${index + 1} down`} size="sm" disabled={index === form.steps.length - 1} onClick={() => move(index, 1)}>
                        <ArrowDown />
                      </IconButton>
                      <Tip content="Remove step">
                        <IconButton label={`Remove step ${index + 1}`} size="sm" onClick={() => setSteps(form.steps.filter((_, i) => i !== index))}>
                          <Trash />
                        </IconButton>
                      </Tip>
                    </span>
                  </div>
                  <textarea
                    aria-label={`Step ${index + 1} instructions`}
                    value={step.instructions}
                    onChange={(e) => updateStep(index, { instructions: e.target.value })}
                    rows={3}
                    placeholder="What the agent is told for this step"
                    className="input input-sm resize-y rounded-lg leading-relaxed"
                  />
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <GatePicker kind={step.kind} gates={step.gates ?? []} onChange={(gates) => updateStep(index, { gates })} />
                    {step.kind === "fix-loop" && (
                      <label className="flex items-center gap-2 text-xs text-fg-subtle">
                        Rounds
                        <input
                          type="number"
                          min={1}
                          max={10}
                          value={step.maxRounds ?? ""}
                          placeholder="Default"
                          onChange={(e) => updateStep(index, { maxRounds: e.target.value ? Number(e.target.value) : undefined })}
                          className="input input-sm w-24 rounded-lg tabular-nums"
                        />
                      </label>
                    )}
                  </div>
                </li>
              ))}
            </ol>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="-ml-2"
              onClick={() => setSteps([...form.steps, { id: "", kind: "custom", instructions: templates.custom ?? "" }])}
            >
              <Plus /> Add step
            </Button>
          </section>

          {error && <Callout tone="danger">{error}</Callout>}
        </ModalBody>
        <ModalFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={saving || !form.name.trim() || !form.steps.length}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

/** The checks that must pass after a step: chips, plus a menu to add or remove them. */
function GatePicker({ kind, gates, onChange }: { kind: PlaybookStepKind; gates: GateName[]; onChange: (gates: GateName[]) => void }) {
  // Only a review step waits for the review.
  const available = GATES.filter((gate) => gate !== "review" || kind === "review");
  const toggle = (gate: GateName, on: boolean) => onChange(on ? GATES.filter((g) => g === gate || gates.includes(g)) : gates.filter((g) => g !== gate));
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-fg-subtle">Checks after it</span>
      {gates.map((gate) => (
        <span key={gate} className="inline-flex h-6 items-center rounded-full bg-fill px-2 text-xs text-fg">
          {GATE_LABELS[gate]}
        </span>
      ))}
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger asChild>
          <button type="button" className="inline-flex h-6 items-center gap-1 rounded-full px-2 text-xs text-fg-muted transition-colors hover:bg-hover hover:text-fg">
            {gates.length ? "Edit" : <><Plus className="size-3" /> Add</>}
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="start" sideOffset={4} className="menu w-52">
            {available.map((gate) => (
              <DropdownMenu.CheckboxItem
                key={gate}
                checked={gates.includes(gate)}
                onCheckedChange={(on) => toggle(gate, on)}
                onSelect={(event) => event.preventDefault()}
                className="menu-item justify-between"
              >
                {GATE_LABELS[gate]}
                <DropdownMenu.ItemIndicator>
                  <Check className="size-3.5 text-fg" />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.CheckboxItem>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}
