import { useState } from "react";
import { toast } from "sonner";
import { DropdownMenu } from "radix-ui";
import { Ellipsis, Pencil, Play, Trash } from "lucide-react";
import type { Routine } from "@shared/types";
import { notifyError } from "../../store";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { cardClass } from "../ui/Card";
import { IconButton } from "../ui/IconButton";
import { Switch } from "../ui/Switch";
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
    <li className={cardClass({ padding: "sm" })}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium text-fg">{routine.name}</span>
            {!routine.enabled && <Badge>Paused</Badge>}
          </div>
          <p className="mt-1 text-xs text-fg-muted">{formatSchedule(routine.schedule)}</p>
          <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-fg-subtle">
            <span>
              {routine.enabled && routine.nextRunAt ? `Next run ${formatRelative(routine.nextRunAt)}` : "Not scheduled"}
            </span>
            {lastConversationId && (
              <>
                <span aria-hidden>·</span>
                <button
                  type="button"
                  onClick={() => onOpenConversation?.(lastConversationId)}
                  className="link-muted"
                >
                  Last run{routine.lastRunAt ? ` ${formatRelative(routine.lastRunAt)}` : ""}
                </button>
              </>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Switch
            checked={routine.enabled}
            onCheckedChange={(enabled) => void setEnabled(enabled)}
            disabled={busy}
            label={`${routine.enabled ? "Pause" : "Enable"} ${routine.name}`}
          />
          <DropdownMenu.Root modal={false}>
            <DropdownMenu.Trigger asChild>
              <IconButton label={`Actions for ${routine.name}`} size="sm" disabled={busy}>
                <Ellipsis />
              </IconButton>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content align="end" sideOffset={4} className="menu w-44">
                <DropdownMenu.Item className="menu-item" onSelect={() => void runNow()} disabled={running}>
                  <Play className="size-4 text-fg-muted" /> Run now
                </DropdownMenu.Item>
                <DropdownMenu.Item className="menu-item" onSelect={() => onEdit(routine)}>
                  <Pencil className="size-4 text-fg-muted" /> Edit
                </DropdownMenu.Item>
                <DropdownMenu.Separator className="menu-separator" />
                <DropdownMenu.Item className="menu-item menu-item-danger" onSelect={() => setConfirming(true)}>
                  <Trash className="size-4" /> Delete
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </div>
      {confirming && (
        <div className="mt-3 flex items-center justify-end gap-2 border-t border-hairline pt-3">
          <span className="mr-auto text-xs text-fg-muted">Delete this routine?</span>
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
