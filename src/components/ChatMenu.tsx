import { useState } from "react";
import { DropdownMenu } from "radix-ui";
import { Ellipsis, ListChecks } from "lucide-react";
import type { Conversation } from "@shared/types";
import { useStore } from "../store";
import { MakeTaskDialog } from "./tasks/MakeTaskDialog";
import { IconButton } from "./ui/IconButton";

/** The open chat's "…" menu in the header. */
export function ChatMenu({ chat }: { chat: Conversation }) {
  const [making, setMaking] = useState(false);
  const busy = useStore((s) => Boolean(s.activeRuns[chat.id]));

  return (
    <>
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger asChild>
          <IconButton label="More chat actions">
            <Ellipsis />
          </IconButton>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={4}
            className="menu w-56"
            onCloseAutoFocus={(event) => {
              if (making) event.preventDefault();
            }}
          >
            <DropdownMenu.Item className="menu-item" disabled={busy} onSelect={() => setMaking(true)}>
              <ListChecks className="size-4 text-fg-muted" />
              <span className="flex-1">Make this a task</span>
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <MakeTaskDialog chat={chat} open={making} onOpenChange={setMaking} />
    </>
  );
}
