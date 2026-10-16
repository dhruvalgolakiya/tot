import { useEffect, useState, type FormEvent } from "react";
import type { TaskConversation } from "../../lib/tasks";
import { patchTask } from "../../store";
import { Button } from "../ui/Button";
import { Modal, ModalBody, ModalFooter } from "../ui/Modal";

export function RenameTaskDialog({ task, open, onOpenChange }: { task: TaskConversation; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [title, setTitle] = useState(task.title);
  useEffect(() => {
    if (open) setTitle(task.title);
  }, [open, task.title]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const next = title.trim();
    if (next && next !== task.title) void patchTask(task.id, { title: next });
    onOpenChange(false);
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Rename task" className="max-w-sm">
      <form onSubmit={submit}>
        <ModalBody>
          <input value={title} onChange={(event) => setTitle(event.target.value)} aria-label="Task title" autoFocus className="input" />
        </ModalBody>
        <ModalFooter divider={false}>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!title.trim()}>
            Rename
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
