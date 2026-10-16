import { useEffect, useState } from "react";
import type { TaskConversation } from "../../lib/tasks";
import { deleteTask } from "../../store";
import { Button } from "../ui/Button";
import { Modal, ModalBody, ModalFooter } from "../ui/Modal";

/** "Delete task?": removes its worktree; its branch stays unless the user ticks the box (and it was never pushed). */
export function DeleteTaskDialog({ task, open, onOpenChange }: { task: TaskConversation; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [deleteBranch, setDeleteBranch] = useState(false);
  useEffect(() => {
    if (open) setDeleteBranch(false);
  }, [open]);
  const branch = task.task.repo?.branch;

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Delete task?"
      description={
        <>
          This deletes <span className="font-medium text-fg">{task.title}</span>
          {branch ? " and its worktree on the computer" : ""}. This can't be undone.
        </>
      }
      className="max-w-sm"
    >
      {branch && (
        <ModalBody className="pb-2">
          <label className="flex items-start gap-2.5 text-sm text-fg-muted">
            <input type="checkbox" checked={deleteBranch} onChange={(event) => setDeleteBranch(event.target.checked)} className="mt-0.5 size-4 accent-fg" />
            <span>
              Also delete branch <span className="font-mono text-ui text-fg">{branch}</span>
              <span className="block text-xs text-fg-subtle">Only if it was never pushed.</span>
            </span>
          </label>
        </ModalBody>
      )}
      <ModalFooter divider={false}>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button
          variant="danger"
          autoFocus
          onClick={() => {
            onOpenChange(false);
            void deleteTask(task.id, { deleteBranch });
          }}
        >
          Delete
        </Button>
      </ModalFooter>
    </Modal>
  );
}
