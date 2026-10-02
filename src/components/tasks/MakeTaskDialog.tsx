import { useEffect, useState, type FormEvent } from "react";
import type { Conversation } from "@shared/types";
import { convertToTask } from "../../store";
import { Button } from "../ui/Button";
import { Field } from "../ui/Field";
import { Modal, ModalBody, ModalFooter } from "../ui/Modal";
import { RepoField } from "./RepoPicker";

/** "Make this a task": the chat keeps its transcript and keeps working on its own until it's done. */
export function MakeTaskDialog({ chat, open, onOpenChange }: { chat: Conversation; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [goal, setGoal] = useState("");
  const [repo, setRepo] = useState("");
  const [baseBranch, setBaseBranch] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setGoal(chat.title);
    setRepo("");
    setBaseBranch("");
    setSaving(false);
  }, [open, chat.title]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!goal.trim() || saving) return;
    setSaving(true);
    const ok = await convertToTask(chat.id, { goal: goal.trim(), ...(repo ? { repo } : {}), ...(repo && baseBranch.trim() ? { baseBranch: baseBranch.trim() } : {}) });
    setSaving(false);
    if (ok) onOpenChange(false);
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Make this a task"
      description="It keeps working in the background until it's done, with this chat as its context. You can steer, pause or stop it."
      className="max-w-md"
    >
      <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
        <ModalBody className="space-y-4">
          <Field label="Goal" htmlFor="make-task-goal" hint="What done looks like, in a sentence or two.">
            <textarea
              id="make-task-goal"
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              rows={3}
              autoFocus
              className="input h-auto min-h-20 resize-y py-2 leading-relaxed"
            />
          </Field>
          <Field label="Repository" hint="For code: the task gets its own branch and worktree on the agent's computer.">
            <RepoField agentId={chat.agentId} value={repo} onChange={setRepo} />
          </Field>
          {repo && (
            <Field label="Base branch" htmlFor="make-task-base" hint="Leave empty for the repo's default branch.">
              <input id="make-task-base" value={baseBranch} onChange={(event) => setBaseBranch(event.target.value)} placeholder="main" className="input" />
            </Field>
          )}
        </ModalBody>
        <ModalFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!goal.trim() || saving}>
            {saving ? "Starting…" : "Make it a task"}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
