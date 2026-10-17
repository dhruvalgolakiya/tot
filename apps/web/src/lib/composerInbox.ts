import type { Attachment } from "@tot/shared/types";

/**
 * Text (and files) the chat hands to its composer: a rewound message to edit and send again.
 * The mounted composer takes it at once; one handed over while none is mounted waits for the next.
 */
export type ComposerInsert = { kind: "draft"; text: string; attachments: Attachment[]; contextChats: string[] };

type Listener = (insert: ComposerInsert) => void;

let listener: Listener | null = null;
let waiting: ComposerInsert[] = [];

export function putInComposer(insert: ComposerInsert): void {
  if (listener) listener(insert);
  else waiting.push(insert);
}

/** The composer listening (one at a time); returns the way to stop. */
export function onComposerInsert(next: Listener): () => void {
  listener = next;
  const queued = waiting;
  waiting = [];
  for (const insert of queued) next(insert);
  return () => {
    if (listener === next) listener = null;
  };
}

/** The composer's text with `insert` in it (the cursor goes at the end). A draft comes first, before anything typed. */
export function withInsert(current: string, insert: ComposerInsert): string {
  return current.trim() ? `${insert.text}\n\n${current}` : insert.text;
}
