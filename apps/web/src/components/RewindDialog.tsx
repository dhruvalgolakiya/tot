import { useEffect, useState } from "react";
import type { RewindPreview } from "@tot/shared/types";
import { api } from "../lib/api";
import { rewindChat, useStore } from "../store";
import { Button } from "./ui/Button";
import { Modal, ModalBody, ModalFooter } from "./ui/Modal";
import { Skeleton } from "./ui/Skeleton";

/**
 * "Rewind to this message?": the message and everything after it leave the chat, and its text goes back into the
 * message box. A chat with a workspace offers to put the files back too, when it has them from those turns.
 */
export function RewindDialog({
  conversationId,
  messageId,
  open,
  onOpenChange,
}: {
  conversationId: string;
  messageId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const busy = useStore((s) => Boolean(s.activeRuns[conversationId]) || s.sending);
  const hasWorkspace = useStore((s) => Boolean(s.conversations.find((c) => c.id === conversationId)?.workspace));
  const [preview, setPreview] = useState<RewindPreview | null>(null);
  const [restoreFiles, setRestoreFiles] = useState(false);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    if (!open) return;
    setPreview(null);
    setRestoreFiles(false);
    if (!hasWorkspace) return;
    let current = true;
    api.rewindPreview(conversationId, messageId).then(
      (found) => current && setPreview(found),
      () => current && setPreview({ messages: 0, files: false }),
    );
    return () => {
      current = false;
    };
  }, [open, hasWorkspace, conversationId, messageId]);

  async function confirm() {
    setWorking(true);
    const done = await rewindChat(conversationId, messageId, { restoreFiles: restoreFiles && Boolean(preview?.files) });
    setWorking(false);
    if (done) onOpenChange(false);
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Rewind to this message?"
      description={
        busy
          ? "Wait for the reply to finish, or stop it, then rewind."
          : "This message and everything after it leave the chat, and the agent forgets them. Its text goes back into the message box to edit and send again."
      }
      className="max-w-sm"
    >
      {hasWorkspace && !busy && (
        <ModalBody className="pb-2">
          {preview === null ? (
            <Skeleton className="h-9 w-full rounded-lg" aria-label="Checking the files" />
          ) : preview.files ? (
            <label className="flex items-start gap-2.5 text-sm text-fg-muted">
              <input type="checkbox" checked={restoreFiles} onChange={(event) => setRestoreFiles(event.target.checked)} className="mt-0.5 size-4 accent-fg" />
              <span>
                Also put the files back
                <span className="block text-xs text-fg-subtle">As they were before this message. Edits and commits since then are undone.</span>
              </span>
            </label>
          ) : (
            <p className="text-xs text-fg-subtle">The agent didn't change any files after this message.</p>
          )}
        </ModalBody>
      )}
      <ModalFooter divider={false}>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="danger" autoFocus disabled={busy || working} onClick={() => void confirm()}>
          {working ? "Rewinding…" : "Rewind"}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
