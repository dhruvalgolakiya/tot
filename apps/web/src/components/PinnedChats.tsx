import { useState, type DragEvent, type ReactNode } from "react";
import clsx from "clsx";
import type { Conversation } from "@tot/shared/types";
import { CHAT_DRAG_TYPE } from "../lib/attached-chats";
import { reorderPinned } from "../store";

/**
 * The pinned chats, in the order they're dragged into: a line shows where a dragged chat will land. Dragging one
 * elsewhere (onto the composer, to attach it) works as before.
 */
export function PinnedChats({ items, children }: { items: Conversation[]; children: (chat: Conversation) => ReactNode }) {
  const [dragging, setDragging] = useState<string | null>(null);
  /** The gap the chat would drop into: 0 is above the first, items.length below the last. */
  const [gap, setGap] = useState<number | null>(null);
  const ids = items.map((c) => c.id);
  const reorderable = dragging !== null && ids.includes(dragging) && ids.length > 1;

  const reset = () => {
    setDragging(null);
    setGap(null);
  };

  const onDrop = (event: DragEvent) => {
    if (!reorderable || gap === null) return reset();
    event.preventDefault();
    const from = ids.indexOf(dragging);
    const to = gap > from ? gap - 1 : gap;
    if (to !== from) {
      const next = ids.filter((id) => id !== dragging);
      next.splice(to, 0, dragging);
      void reorderPinned(next);
    }
    reset();
  };

  return (
    <ul
      className="space-y-px"
      // The row's own dragstart has set the chat's id by the time this hears it.
      onDragStart={(event) => setDragging(event.dataTransfer.getData(CHAT_DRAG_TYPE) || null)}
      onDragEnd={reset}
      onDragLeave={(event) => !event.currentTarget.contains(event.relatedTarget as Node | null) && setGap(null)}
      onDrop={onDrop}
    >
      {items.map((chat, index) => (
        <li
          key={chat.id}
          className="relative"
          onDragOver={(event) => {
            if (!reorderable) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            const box = event.currentTarget.getBoundingClientRect();
            setGap(event.clientY < box.top + box.height / 2 ? index : index + 1);
          }}
        >
          {gap === index && <DropLine edge="top" />}
          {children(chat)}
          {gap === items.length && index === items.length - 1 && <DropLine edge="bottom" />}
        </li>
      ))}
    </ul>
  );
}

function DropLine({ edge }: { edge: "top" | "bottom" }) {
  return (
    <span
      aria-hidden="true"
      className={clsx("pointer-events-none absolute inset-x-2 z-10 h-0.5 rounded-full bg-accent", edge === "top" ? "-top-px" : "-bottom-px")}
    />
  );
}
