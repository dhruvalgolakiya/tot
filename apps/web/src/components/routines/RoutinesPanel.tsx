import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import type { Routine } from "@shared/types";
import { Button } from "../ui/Button";
import { Callout } from "../ui/Callout";
import { EmptyState } from "../ui/EmptyState";
import { Modal, ModalBody } from "../ui/Modal";
import { Skeleton } from "../ui/Skeleton";
import { RoutineForm } from "./RoutineForm";
import { RoutineRow } from "./RoutineRow";
import type { RoutineFormValues } from "./formValues";
import { errorMessage, routinesApi } from "./routinesApi";

export interface RoutinesPanelProps {
  agentId: string;
  agentName: string;
  /** Called with the new/last-run chat's id, e.g. to navigate there. */
  onOpenConversation?: (conversationId: string) => void;
}

interface ExampleChip {
  label: string;
  values: Partial<RoutineFormValues>;
}

const EXAMPLES: ExampleChip[] = [
  {
    label: "Every morning at 8:00 — brief me on AI news",
    values: {
      name: "Morning AI news",
      prompt: "Brief me on today's top AI news.",
      scheduleKind: "daily",
      time: "08:00",
      days: [],
    },
  },
  {
    label: "Every Friday at 17:00 — summarize my week",
    values: {
      name: "Weekly summary",
      prompt: "Summarize what I worked on this week.",
      scheduleKind: "daily",
      time: "17:00",
      days: [5],
    },
  },
  {
    label: "Every 2 hours — check my site is up",
    values: {
      name: "Site uptime check",
      prompt: "Check that my site is up and reachable. Tell me right away if it isn't.",
      scheduleKind: "interval",
      intervalValue: "2",
      intervalUnit: "hours",
    },
  },
];

/** An agent's routines: recurring tasks it runs on its own schedule. */
export function RoutinesPanel({ agentId, agentName, onOpenConversation }: RoutinesPanelProps) {
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Routine | null>(null);
  const [prefill, setPrefill] = useState<Partial<RoutineFormValues> | undefined>(undefined);

  function load() {
    setLoadError(null);
    routinesApi.list(agentId).then(setRoutines, (error: unknown) => setLoadError(errorMessage(error)));
  }

  useEffect(() => {
    setRoutines(null);
    load();
    // Reload whenever the panel switches to a different agent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  const replace = (routine: Routine) =>
    setRoutines((list) => {
      if (!list) return list;
      return list.some((r) => r.id === routine.id)
        ? list.map((r) => (r.id === routine.id ? routine : r))
        : [...list, routine];
    });
  const remove = (id: string) => setRoutines((list) => list?.filter((r) => r.id !== id) ?? null);

  function openCreate(values?: Partial<RoutineFormValues>) {
    setEditing(null);
    setPrefill(values);
    setFormOpen(true);
  }

  function openEdit(routine: Routine) {
    setEditing(routine);
    setPrefill(undefined);
    setFormOpen(true);
  }

  return (
    <div className="space-y-4">
      {loadError && (
        <Callout tone="danger" action={<button type="button" onClick={load} className="link-muted">Retry</button>}>
          {loadError}
        </Callout>
      )}

      {!routines && !loadError && (
        <div className="space-y-2" aria-busy="true" aria-label="Loading routines">
          <Skeleton className="h-16 rounded-xl" />
          <Skeleton className="h-16 rounded-xl" />
        </div>
      )}

      {routines && routines.length === 0 && (
        <EmptyState
          size="sm"
          description={`Routines let ${agentName} do things on a schedule without you asking — like a morning news brief or a weekly recap. Each run starts a new chat you can check anytime.`}
          action={
            <div className="flex flex-wrap justify-center gap-2">
              {EXAMPLES.map((example) => (
                <button
                  key={example.label}
                  type="button"
                  onClick={() => openCreate(example.values)}
                  className="rounded-full border border-edge bg-fill-subtle px-3 py-1.5 text-xs text-fg-muted transition-colors hover:border-edge-strong hover:bg-hover hover:text-fg"
                >
                  {example.label}
                </button>
              ))}
            </div>
          }
        />
      )}

      {routines && routines.length > 0 && (
        <ul className="space-y-2">
          {routines.map((routine) => (
            <RoutineRow
              key={routine.id}
              routine={routine}
              onChanged={replace}
              onDeleted={remove}
              onEdit={openEdit}
              onOpenConversation={onOpenConversation}
            />
          ))}
        </ul>
      )}

      <div className="flex items-center justify-between gap-3">
        <p className="text-xs leading-relaxed text-fg-subtle">
          You can also just ask {agentName} in chat, e.g. “every weekday at 9, send me…”
        </p>
        <Button size="sm" onClick={() => openCreate()} disabled={!routines} className="shrink-0">
          <Plus /> New routine
        </Button>
      </div>

      <Modal open={formOpen} onOpenChange={setFormOpen} title={editing ? "Edit routine" : "New routine"} className="max-w-lg">
        <ModalBody className="max-h-[65vh]">
          <RoutineForm
            agentId={agentId}
            routine={editing ?? undefined}
            initialValues={prefill}
            onSaved={(routine) => {
              replace(routine);
              setFormOpen(false);
            }}
            onCancel={() => setFormOpen(false)}
          />
        </ModalBody>
      </Modal>
    </div>
  );
}
