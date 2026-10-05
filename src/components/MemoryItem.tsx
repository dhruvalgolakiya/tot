import { useState } from "react";
import clsx from "clsx";
import { Pencil, Trash } from "lucide-react";
import type { Memory } from "@shared/types";
import { api } from "../lib/api";
import { notifyError } from "../store";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";
import { Tip } from "./ui/Tip";

type MemoryItemProps = {
  memory: Memory;
  /** Hairline above every row but a file's first. */
  first?: boolean;
  /** Which file it's in, for search results that mix files. */
  showPath?: boolean;
  onUpdated: (memory: Memory) => void;
  onDeleted: (id: string) => void;
};

const day = (time: number) => new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric", year: new Date(time).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });

/** One memory entry as a row: its text, who saved it and when; edit and delete on hover. */
export function MemoryItem({ memory, first = false, showPath = false, onUpdated, onDeleted }: MemoryItemProps) {
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
      onUpdated(await api.updateMemory(memory.id, content, memory.repo));
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
      await api.deleteMemory(memory.id, memory.repo);
      onDeleted(memory.id);
    } catch (error) {
      notifyError(error);
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <li className={clsx("px-4 py-3", !first && "border-t border-hairline")}>
        <textarea
          autoFocus
          rows={2}
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
          className="input resize-y rounded-xl leading-relaxed"
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
    <li className={clsx("group flex items-start gap-3 px-4 py-2.5", !first && "border-t border-hairline")}>
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-relaxed text-fg [overflow-wrap:anywhere]">{memory.content}</p>
        <p className="mt-0.5 text-xs text-fg-subtle">
          {memory.source === "agent" ? "Saved by an agent" : "Added by you"}
          <span className="tabular-nums"> · {day(memory.createdAt)}</span>
          {showPath && <span className="font-mono"> · {memory.path}</span>}
        </p>
      </div>
      <div className="flex h-7 shrink-0 items-center gap-1">
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
    </li>
  );
}
