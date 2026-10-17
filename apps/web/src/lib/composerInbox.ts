import type { Attachment } from "@tot/shared/types";

/**
 * Text (and files) the chat hands to its composer: a rewound message to edit and send again, a quote from a reply.
 * The mounted composer takes it at once; one handed over while none is mounted waits for the next.
 */
export type ComposerInsert =
  | { kind: "draft"; text: string; attachments: Attachment[]; contextChats: string[] }
  | { kind: "quote"; text: string };

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

/** `selection` as a markdown quote, every line prefixed (blank ones too, so it stays one quote). */
export function asQuote(selection: string): string {
  return selection
    .trim()
    .split("\n")
    .map((line) => (line.trim() ? `> ${line.trimEnd()}` : ">"))
    .join("\n");
}

/**
 * The composer's text with `insert` in it (the cursor goes at the end). A draft comes first, before anything typed; a
 * quote goes after it, with a blank line to write under.
 */
export function withInsert(current: string, insert: ComposerInsert): string {
  if (insert.kind === "draft") return current.trim() ? `${insert.text}\n\n${current}` : insert.text;
  const quote = `${asQuote(insert.text)}\n\n`;
  return current.trim() ? `${current.trimEnd()}\n\n${quote}` : quote;
}
