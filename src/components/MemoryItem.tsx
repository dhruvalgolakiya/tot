import { useState } from "react";
import { Pencil, Trash } from "lucide-react";
import type { Memory } from "@shared/types";
import { api } from "../lib/api";
import { relativeTime } from "../lib/format";
import { notifyError } from "../store";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";
import { Tip } from "./ui/Tip";

type MemoryItemProps = {
  memory: Memory;
  onUpdated: (memory: Memory) => void;
  onDeleted: (id: string) => void;
};

export function MemoryItem({ memory, onUpdated, onDeleted }: MemoryItemProps) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(memory.content);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function save() {
    const content = value.trim();
    if (!content || content === memory.content) {
      setEditing(false);
      return;
    }
    setBusy(true);
    try {
      onUpdated(await api.updateMemory(memory.id, content));
      setEditing(false);
    } catch (error) {
      notifyError(error);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api.deleteMemory(memory.id);
      onDeleted(memory.id);
    } catch (error) {
      notifyError(error);
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <li className="rounded-xl border border-accent-edge bg-fill-subtle p-3">
        <textarea
          autoFocus
          rows={3}
          value={value}
          data-escape-cancels
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void save();
            if (event.key === "Escape") {
              setValue(memory.content);
              setEditing(false);
            }
          }}
          aria-label="Edit memory"
          className="input resize-y leading-relaxed"
        />
        <div className="mt-2 flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" onClick={() => void save()} disabled={busy || !value.trim()}>
            Save
          </Button>
        </div>
      </li>
    );
  }

  return (
    <li className="group rounded-xl border border-hairline bg-fill-subtle px-3.5 py-3 transition-colors hover:border-edge">
      <p className="text-sm leading-relaxed whitespace-pre-wrap text-fg [overflow-wrap:anywhere]">{memory.content}</p>
      <div className="mt-2 flex h-7 items-center gap-2 text-xs text-fg-subtle">
        <Badge tone={memory.source === "agent" ? "accent" : "neutral"}>
          {memory.source === "agent" ? "Saved by TOT" : "Added by you"}
        </Badge>
        <span>{relativeTime(memory.updatedAt)}</span>
        <div className="ml-auto flex items-center gap-1">
          {confirming ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>
                Cancel
              </Button>
              <Button size="sm" variant="danger" onClick={() => void remove()} disabled={busy}>
                Delete
              </Button>
            </>
          ) : (
            <div className="flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100">
              <Tip content="Edit">
                <IconButton label="Edit memory" size="sm" onClick={() => setEditing(true)}>
                  <Pencil />
                </IconButton>
              </Tip>
              <Tip content="Delete">
                <IconButton label="Delete memory" size="sm" onClick={() => setConfirming(true)}>
                  <Trash />
                </IconButton>
              </Tip>
            </div>
          )}
        </div>
      </div>
    </li>
  );
}
