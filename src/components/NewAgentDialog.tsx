import { setNewAgentDialogOpen, useStore } from "../store";
import { AgentForm } from "./AgentForm";
import { Modal } from "./ui/Modal";

export function NewAgentDialog() {
  const open = useStore((s) => s.newAgentDialogOpen);

  return (
    <Modal
      open={open}
      onOpenChange={setNewAgentDialogOpen}
      title="New agent"
      description="Each agent is its own workspace, with its own computer, chats, wiki and routines. What it learns about you is shared with every agent."
      className="flex max-w-lg"
    >
      <AgentForm target={null} canDelete={false} />
    </Modal>
  );
}
