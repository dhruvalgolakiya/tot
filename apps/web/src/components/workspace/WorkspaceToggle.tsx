import { useEffect } from "react";
import { PanelRight } from "lucide-react";
import type { Conversation } from "@tot/shared/types";
import { hasWorkspace, toggleWorkspacePanel, useWorkspacePanel } from "../../lib/workspace";
import { IconButton } from "../ui/IconButton";
import { Kbd } from "../ui/Kbd";
import { Tip } from "../ui/Tip";

/** The header's button for the workspace panel (⌘J / Ctrl+J), on chats that work in a folder. */
export function WorkspaceToggle({ chat }: { chat: Conversation | undefined }) {
  const open = useWorkspacePanel((s) => s.open);
  const shown = hasWorkspace(chat);

  useEffect(() => {
    if (!shown) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey || event.isComposing) return;
      if (event.code !== "KeyJ" && event.key.toLowerCase() !== "j") return;
      event.preventDefault();
      toggleWorkspacePanel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [shown]);

  if (!shown) return null;
  return (
    <Tip
      side="bottom"
      content={
        <span className="flex items-center gap-2">
          {open ? "Hide workspace" : "Show workspace"} <Kbd keys={["mod", "J"]} />
        </span>
      }
    >
      <IconButton label={open ? "Hide workspace" : "Show workspace"} aria-pressed={open} onClick={toggleWorkspacePanel}>
        <PanelRight />
      </IconButton>
    </Tip>
  );
}
