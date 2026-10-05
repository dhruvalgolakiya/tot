import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import type { Attachment } from "@shared/types";
import { api } from "../lib/api";
import { onDevice } from "../lib/devices";
import { notifyError } from "../store";

/** Matches the server's `SendMessageRequest.attachments` limit. */
export const MAX_ATTACHMENTS = 10;
const MAX_FILE_BYTES = 25 * 1024 * 1024;

export interface PendingAttachment {
  localId: string;
  file: File;
  status: "uploading" | "done" | "error";
  attachment?: Attachment;
}

let seq = 0;
const nextLocalId = () => `att-${Date.now().toString(36)}-${(seq++).toString(36)}`;

/**
 * Composer file attachments: pick/drop/paste, upload immediately, track per-file state. Files go to
 * `deviceId`, the paired device the chat's agent lives on (module 07), or this device when null.
 */
export function useAttachments(deviceId: string | null = null) {
  const [items, setItems] = useState<PendingAttachment[]>([]);
  const device = useRef(deviceId);
  device.current = deviceId;

  const upload = useCallback((localId: string, file: File) => {
    onDevice(device.current, () => api.uploadFile(file)).then(
      (attachment) => {
        setItems((current) => current.map((it) => (it.localId === localId ? { ...it, status: "done", attachment } : it)));
      },
      (error) => {
        notifyError(error);
        setItems((current) => current.map((it) => (it.localId === localId ? { ...it, status: "error" } : it)));
      },
    );
  }, []);

  const addFiles = useCallback(
    (files: FileList | File[] | null | undefined) => {
      if (!files || files.length === 0) return;
      const list = Array.from(files);
      // Captured fresh on every invocation of the updater below (including React
      // StrictMode's double-invoke-and-discard), then acted on once afterwards —
      // keeps the updater itself pure while still emitting exactly one toast.
      let accepted: PendingAttachment[] = [];
      let rejections: string[] = [];
      setItems((current) => {
        accepted = [];
        rejections = [];
        const room = MAX_ATTACHMENTS - current.length;
        if (room <= 0) {
          rejections.push(`You can attach up to ${MAX_ATTACHMENTS} files.`);
          return current;
        }
        if (list.length > room) {
          rejections.push(`Only ${room} more file${room === 1 ? "" : "s"} can be attached — ${list.length - room} skipped.`);
        }
        for (const file of list.slice(0, room)) {
          if (file.size > MAX_FILE_BYTES) {
            rejections.push(`${file.name} is larger than 25 MB.`);
            continue;
          }
          accepted.push({ localId: nextLocalId(), file, status: "uploading" });
        }
        return accepted.length ? [...current, ...accepted] : current;
      });
      rejections.forEach((message) => toast.error(message));
      for (const item of accepted) upload(item.localId, item.file);
    },
    [upload],
  );

  const removeAttachment = useCallback((localId: string) => {
    setItems((current) => current.filter((it) => it.localId !== localId));
  }, []);

  const clear = useCallback(() => setItems([]), []);

  /** Put previously-cleared attachments back (e.g. the send that consumed them failed). */
  const restore = useCallback((previous: PendingAttachment[]) => {
    if (previous.length === 0) return;
    setItems((current) => (current.length === 0 ? previous : current));
  }, []);

  const uploading = items.some((it) => it.status === "uploading");
  const ready = items.filter((it) => it.status === "done" && it.attachment) as (PendingAttachment & {
    attachment: Attachment;
  })[];

  return { items, addFiles, removeAttachment, clear, restore, uploading, ready };
}

export type UseAttachments = ReturnType<typeof useAttachments>;
