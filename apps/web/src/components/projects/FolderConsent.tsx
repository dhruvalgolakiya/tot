import { useEffect, useState } from "react";
import type { Project } from "@tot/shared/types";
import { ApiError, errorMessage } from "../../lib/api";
import { grantProjectFolder, sourceLabel } from "../../lib/projects";
import { Button } from "../ui/Button";
import { Callout } from "../ui/Callout";
import { Modal, ModalBody, ModalFooter } from "../ui/Modal";

/** The question, word for word in every place it's asked. */
export const folderConsentTitle = (folder: string) => `Let agents work in ${folder}?`;

/** What saying yes means, in plain words. */
export function FolderConsentText() {
  return (
    <p className="text-sm leading-relaxed text-fg-muted">
      They can read everything in this folder and make branches (<span className="font-mono text-ui">tot/…</span>) in its git repo. They
      can't change your checked-out files, push, or see anything outside this folder.
    </p>
  );
}

type FolderConsentDialogProps = {
  project: Project;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** For a folder project made before the user said yes: asks once, then grants it. */
export function FolderConsentDialog({ project, open, onOpenChange }: FolderConsentDialogProps) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setSaving(false);
    setError(null);
  }, [open]);

  async function allow() {
    setSaving(true);
    setError(null);
    try {
      await grantProjectFolder(project.id);
      onOpenChange(false);
    } catch (err) {
      // A server from before folder grants answers the route itself with a bare 404.
      const missing = err instanceof ApiError && err.status === 404 && err.message.startsWith("Request failed");
      setError(missing ? "This TOT server can't allow folders yet. Update it, then try again." : errorMessage(err));
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={folderConsentTitle(sourceLabel(project))} className="max-w-md">
      <ModalBody className="space-y-4 pb-2">
        <FolderConsentText />
        {error && <Callout tone="danger">{error}</Callout>}
      </ModalBody>
      <ModalFooter divider={false}>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="primary" autoFocus disabled={saving} onClick={() => void allow()}>
          {saving ? "Allowing…" : "Allow"}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
