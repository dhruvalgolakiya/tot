import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import { MAX_ATTACHED_CHATS } from "../lib/attached-chats";
import { onComposerInsert, withInsert } from "../lib/composerInbox";
import type { UseAttachments } from "./useAttachments";

/** The composer takes what the chat hands it (lib/composerInbox): text where it belongs, files and chats in its tray, the cursor at the end. */
export function useComposerInbox({
  inputRef,
  setText,
  setCaret,
  setContextChats,
  attachments,
}: {
  inputRef: RefObject<HTMLTextAreaElement | null>;
  setText: Dispatch<SetStateAction<string>>;
  setCaret: (caret: number) => void;
  setContextChats: Dispatch<SetStateAction<string[]>>;
  attachments: UseAttachments;
}) {
  const { addUploaded } = attachments;
  useEffect(
    () =>
      onComposerInsert((insert) => {
        const current = inputRef.current?.value ?? "";
        const next = withInsert(current, insert);
        setText(next);
        if (insert.kind === "draft") {
          addUploaded(insert.attachments);
          if (insert.contextChats.length) {
            setContextChats((list) => [...new Set([...list, ...insert.contextChats])].slice(0, MAX_ATTACHED_CHATS));
          }
        }
        requestAnimationFrame(() => {
          const input = inputRef.current;
          if (!input) return;
          input.focus();
          input.setSelectionRange(next.length, next.length);
          input.scrollTop = input.scrollHeight;
          setCaret(next.length);
        });
      }),
    [inputRef, setText, setCaret, setContextChats, addUploaded],
  );
}
