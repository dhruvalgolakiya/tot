import { useState } from "react";
import { toast } from "sonner";
import { Pencil, Play, Trash } from "lucide-react";
import type { Routine } from "@shared/types";
import { notifyError } from "../../store";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { Switch } from "../ui/Switch";
import { Tip } from "../ui/Tip";
import { formatRelative, formatSchedule } from "./format";
import { routinesApi } from "./routinesApi";

export interface RoutineRowProps {
  routine: Routine;
  onChanged: (routine: Routine) => void;
  onDeleted: (id: string) => void;
  onEdit: (routine: Routine) => void;
  onOpenConversation?: (conversationId: string) => void;
}

/** One routine: schedule, next/last run, and its enable/run/edit/delete actions. */
export function RoutineRow({ routine, onChanged, onDeleted, onEdit, onOpenConversation }: RoutineRowProps) {
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [confirming, setConfirming] = useState(false);

  async function setEnabled(enabled: boolean) {
    setBusy(true);
    onChanged({ ...routine, enabled });
    try {
      onChanged(await routinesApi.update(routine.id, { enabled }));
    } catch (error) {
      onChanged(routine);
      notifyError(error);
    } finally {
      setBusy(false);
    }
  }

  async function runNow() {
    setRunning(true);
    try {
      const { conversationId } = await routinesApi.run(routine.id);
      toast.success(`${routine.name} is running`);
      onOpenConversation?.(conversationId);
    } catch (error) {
      notifyError(error);
    } finally {
      setRunning(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await routinesApi.remove(routine.id);
      onDeleted(routine.id);
    } catch (error) {
      notifyError(error);
      setBusy(false);
    }
  }

  const lastConversationId = routine.lastConversationId;

  return (
    <li className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3.5">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium text-zinc-100">{routine.name}</span>
            {!routine.enabled && (
              <span className="rounded-md bg-white/[0.06] px-1.5 py-px text-[11px] font-medium text-zinc-400">
                Paused
              </span>
            )}
          </div>
          <p className="mt-1 text-xs text-zinc-400">{formatSchedule(routine.schedule)}</p>
          <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-zinc-500">
            <span>
              {routine.enabled && routine.nextRunAt ? `Next run ${formatRelative(routine.nextRunAt)}` : "Not scheduled"}
            </span>
            {lastConversationId && (
              <>
                <span aria-hidden>·</span>
                <button
                  type="button"
                  onClick={() => onOpenConversation?.(lastConversationId)}
                  className="text-zinc-400 underline decoration-dotted underline-offset-2 hover:text-zinc-200"
                >
                  Last run{routine.lastRunAt ? ` ${formatRelative(routine.lastRunAt)}` : ""}
                </button>
              </>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Tip content="Run now">
            <IconButton
              label={`Run ${routine.name} now`}
              size="sm"
              onClick={() => void runNow()}
              disabled={busy || running}
            >
              <Play />
            </IconButton>
          </Tip>
          <Switch
            checked={routine.enabled}
            onCheckedChange={(enabled) => void setEnabled(enabled)}
            disabled={busy}
            label={`${routine.enabled ? "Pause" : "Enable"} ${routine.name}`}
          />
          <Tip content="Edit">
            <IconButton label={`Edit ${routine.name}`} size="sm" onClick={() => onEdit(routine)} disabled={busy}>
              <Pencil />
            </IconButton>
          </Tip>
          {!confirming && (
            <Tip content="Delete">
              <IconButton label={`Delete ${routine.name}`} size="sm" onClick={() => setConfirming(true)} disabled={busy}>
                <Trash />
              </IconButton>
            </Tip>
          )}
        </div>
      </div>
      {confirming && (
        <div className="mt-3 flex items-center justify-end gap-2 border-t border-white/[0.06] pt-3">
          <span className="mr-auto text-xs text-zinc-400">Delete this routine?</span>
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
