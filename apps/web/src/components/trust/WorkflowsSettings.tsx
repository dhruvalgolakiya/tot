import { Fragment, useEffect, useMemo, useState } from "react";
import { DropdownMenu } from "radix-ui";
import { ChevronRight, Copy, Ellipsis, Pencil, Plus, Trash } from "lucide-react";
import type { Playbook, PlaybookInput, PlaybookStepKind, WorkflowSettings } from "@tot/shared/types";
import { errorMessage } from "../../lib/api";
import { notifyError } from "../../store";
import { ConfirmDialog } from "../ConfirmDialog";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Callout } from "../ui/Callout";
import { IconButton } from "../ui/IconButton";
import { LedgerField, LedgerGroup, ledgerRowClass } from "../ui/Ledger";
import { Select } from "../ui/Select";
import { Skeleton } from "../ui/Skeleton";
import { Switch } from "../ui/Switch";
import { PlaybookEditor, STEP_LABELS } from "./PlaybookEditor";
import { trustApi } from "./trustApi";

type Editing = { title: string; id: string | null; input: PlaybookInput };

const toInput = ({ name, description, match, steps }: Playbook): PlaybookInput => ({ name, description, match, steps });

/** "Bug fix (copy)", or "(copy 2)" when that's taken. */
function copyName(name: string, playbooks: Playbook[]): string {
  const taken = new Set(playbooks.map((p) => p.name.toLowerCase()));
  let candidate = `${name} (copy)`;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) candidate = `${name} (copy ${n})`;
  return candidate;
}

/** Settings → Workflows: the defaults coding tasks follow, and the playbooks they're matched to. Changes apply immediately. */
export function WorkflowsSettings() {
  const [flows, setFlows] = useState<WorkflowSettings | null>(null);
  const [playbooks, setPlaybooks] = useState<Playbook[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [deleting, setDeleting] = useState<Playbook | null>(null);

  function load() {
    setLoadError(null);
    Promise.all([trustApi.workflows(), trustApi.playbooks()]).then(
      ([nextFlows, nextPlaybooks]) => {
        setFlows(nextFlows);
        setPlaybooks(nextPlaybooks);
      },
      (err: unknown) => setLoadError(errorMessage(err)),
    );
  }

  useEffect(load, []);

  // A new step starts from the built-in instructions for its kind.
  const templates = useMemo(() => {
    const found: Partial<Record<PlaybookStepKind, string>> = {};
    for (const playbook of playbooks ?? []) for (const step of playbook.builtIn ? playbook.steps : []) found[step.kind] ??= step.instructions;
    return found;
  }, [playbooks]);

  async function patchFlows(patch: Partial<WorkflowSettings>) {
    if (!flows) return;
    const before = flows;
    setFlows({ ...flows, ...patch });
    try {
      setFlows(await trustApi.updateWorkflows(patch));
    } catch (err) {
      setFlows(before);
      notifyError(err);
    }
  }

  const replace = (playbook: Playbook) => setPlaybooks((list) => list?.map((p) => (p.id === playbook.id ? playbook : p)) ?? null);

  async function setEnabled(playbook: Playbook, enabled: boolean) {
    replace({ ...playbook, enabled });
    try {
      replace(await trustApi.updatePlaybook(playbook.id, { enabled }));
    } catch (err) {
      replace(playbook);
      notifyError(err);
    }
  }

  async function save(input: PlaybookInput) {
    if (!editing) return;
    if (editing.id) {
      replace(await trustApi.updatePlaybook(editing.id, input));
    } else {
      const created = await trustApi.createPlaybook(input);
      setPlaybooks((list) => [...(list ?? []), created]);
    }
  }

  async function remove(playbook: Playbook) {
    try {
      await trustApi.deletePlaybook(playbook.id);
      setPlaybooks((list) => list?.filter((p) => p.id !== playbook.id) ?? null);
    } catch (err) {
      notifyError(err);
    }
  }

  const duplicate = (playbook: Playbook) =>
    setEditing({ title: `Duplicate ${playbook.name}`, id: null, input: { ...toInput(playbook), name: copyName(playbook.name, playbooks ?? []) } });

  if (loadError) {
    return (
      <Callout
        tone="danger"
        action={
          <button type="button" onClick={load} className="link-muted">
            Try again
          </button>
        }
      >
        {loadError}
      </Callout>
    );
  }
  if (!flows || !playbooks) {
    return (
      <div className="space-y-4" aria-busy="true" aria-label="Loading workflows">
        <Skeleton className="h-36 w-full rounded-xl" />
        <Skeleton className="h-20 w-full rounded-xl" />
        <Skeleton className="h-20 w-full rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <LedgerGroup title="Defaults" description="For every coding task, whichever playbook it follows.">
        <LedgerField
          title="Require my OK on plans"
          description="Agents stop after planning and wait for you before changing code."
          control={<Switch checked={flows.requirePlanApproval} onCheckedChange={(on) => void patchFlows({ requirePlanApproval: on })} label="Require my OK on plans" />}
        />
        <LedgerField
          title="Reviewer"
          description="A fresh model reviews every diff before you see it. The other provider catches what the author's own model misses."
          control={
            <Select
              aria-label="Reviewer"
              size="sm"
              value={flows.reviewer}
              onValueChange={(reviewer) => void patchFlows({ reviewer: reviewer as WorkflowSettings["reviewer"] })}
              options={[
                { value: "other", label: "Other provider" },
                { value: "claude", label: "Claude" },
                { value: "chatgpt", label: "ChatGPT" },
              ]}
              className="w-40 rounded-lg"
            />
          }
        />
        <LedgerField
          title="Fix rounds"
          description="Rounds of fixes after failed checks or a review, before the agent asks you."
          control={
            <Select
              aria-label="Fix rounds"
              size="sm"
              value={String(flows.maxFixRounds)}
              onValueChange={(rounds) => void patchFlows({ maxFixRounds: Number(rounds) })}
              options={[1, 2, 3, 4, 5].map((n) => ({ value: String(n), label: n === 1 ? "1 round" : `${n} rounds` }))}
              className="w-40 rounded-lg"
            />
          }
        />
      </LedgerGroup>

      <section className="space-y-3">
        <LedgerGroup body="rows"
          title="Playbooks"
          count={playbooks.length}
         
          description="Each coding task follows the playbook that fits it best; its steps become the task's checklist."
          action={
            <Button
              size="sm"
              variant="secondary"
              onClick={() =>
                setEditing({
                  title: "New playbook",
                  id: null,
                  input: { name: "", description: "", match: [], steps: [{ id: "", kind: "understand", instructions: templates.understand ?? "" }] },
                })
              }
            >
              <Plus /> New playbook
            </Button>
          }
        >
          <ul>
            {playbooks.map((playbook) => (
              <li key={playbook.id} className={ledgerRowClass({ className: "items-start" })}>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium text-fg">{playbook.name}</span>
                    {playbook.builtIn && <Badge>Built-in</Badge>}
                  </div>
                  {playbook.description && <p className="mt-0.5 text-xs leading-relaxed text-fg-subtle">{playbook.description}</p>}
                  <ol aria-label={`${playbook.name} steps`} className="mt-2 flex flex-wrap items-center gap-x-1 gap-y-1 text-xs text-fg-muted">
                    {playbook.steps.map((step, index) => (
                      <Fragment key={step.id}>
                        {index > 0 && <ChevronRight aria-hidden="true" className="size-3 text-fg-faint" />}
                        <li>{step.kind === "approve-plan" && !flows.requirePlanApproval ? <span className="text-fg-faint line-through">Approve plan</span> : STEP_LABELS[step.kind]}</li>
                      </Fragment>
                    ))}
                  </ol>
                </div>
                <div className="flex shrink-0 items-center gap-1 pt-0.5">
                  <Switch checked={playbook.enabled} onCheckedChange={(on) => void setEnabled(playbook, on)} label={`Use ${playbook.name}`} />
                  <DropdownMenu.Root modal={false}>
                    <DropdownMenu.Trigger asChild>
                      <IconButton label={`More ${playbook.name} options`} size="sm">
                        <Ellipsis />
                      </IconButton>
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content align="end" sideOffset={4} className="menu w-48">
                        {playbook.builtIn ? (
                          <DropdownMenu.Item className="menu-item" onSelect={() => duplicate(playbook)}>
                            <Copy className="size-4 text-fg-muted" /> Duplicate & edit
                          </DropdownMenu.Item>
                        ) : (
                          <>
                            <DropdownMenu.Item className="menu-item" onSelect={() => setEditing({ title: "Edit playbook", id: playbook.id, input: toInput(playbook) })}>
                              <Pencil className="size-4 text-fg-muted" /> Edit
                            </DropdownMenu.Item>
                            <DropdownMenu.Item className="menu-item" onSelect={() => duplicate(playbook)}>
                              <Copy className="size-4 text-fg-muted" /> Duplicate
                            </DropdownMenu.Item>
                            <DropdownMenu.Separator className="menu-separator" />
                            <DropdownMenu.Item className="menu-item menu-item-danger" onSelect={() => setDeleting(playbook)}>
                              <Trash className="size-4" /> Delete
                            </DropdownMenu.Item>
                          </>
                        )}
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                </div>
              </li>
            ))}
          </ul>
        </LedgerGroup>
      </section>

      <PlaybookEditor
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        title={editing?.title ?? ""}
        initial={editing?.input ?? { name: "", description: "", match: [], steps: [] }}
        templates={templates}
        onSave={save}
      />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.name ?? "playbook"}?`}
        description="Coding tasks won't be matched to it anymore."
        confirmLabel="Delete"
        onConfirm={() => deleting && void remove(deleting)}
      />
    </div>
  );
}
