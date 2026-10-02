import { memo } from "react";
import clsx from "clsx";
import { Check, Copy, Download } from "lucide-react";
import type { Attachment, Message, MessagePart } from "@shared/types";
import { useCopy } from "../hooks/useCopy";
import { formatBytes } from "../lib/format";
import { fileIcon, isImageMime } from "../lib/fileIcon";
import { messageText } from "../lib/tools";
import { IconButton } from "./ui/IconButton";
import { Tip } from "./ui/Tip";

function ImageAttachment({ attachment }: { attachment: Attachment }) {
  return (
    <a
      href={attachment.url}
      target="_blank"
      rel="noopener noreferrer"
      className="block max-w-56 overflow-hidden rounded-xl border border-hairline transition-opacity hover:opacity-90"
      title={`Open ${attachment.name}`}
    >
      <img src={attachment.url} alt={attachment.name} className="block max-h-72 w-full object-cover" />
    </a>
  );
}

function FileAttachment({ attachment }: { attachment: Attachment }) {
  const Icon = fileIcon(attachment.mimeType);
  return (
    <a
      href={attachment.url}
      target="_blank"
      rel="noopener noreferrer"
      className="flex max-w-72 items-center gap-2.5 rounded-xl border border-hairline bg-fill-subtle py-2 pr-3 pl-2.5 transition-colors hover:bg-hover"
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-fill">
        <Icon className="size-4 text-fg-muted" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-ui font-medium text-fg">{attachment.name}</span>
        <span className="block text-2xs text-fg-subtle tabular-nums">{formatBytes(attachment.size)}</span>
      </span>
      <Download className="size-3.5 shrink-0 text-fg-subtle" />
    </a>
  );
}

/** A turn TOT sent itself to keep a task going: a quiet divider, not a bubble. */
function AutoDivider({ text }: { text: string }) {
  return (
    <div role="separator" aria-label={text} className="flex items-center gap-3 text-xs text-fg-subtle">
      <span className="h-px flex-1 bg-hairline" />
      <span className="max-w-[70%] truncate">{text.replace(/\.$/, "")}</span>
      <span className="h-px flex-1 bg-hairline" />
    </div>
  );
}

/** A note the user sent while a task worked; `inline` when it sits inside the reply it was handed to. */
export function SteerNote({ message, inline = false }: { message: Message; inline?: boolean }) {
  return (
    <div className={clsx("flex flex-col items-end", inline && "my-1")}>
      <span className="mb-1 text-2xs font-medium text-fg-subtle">{inline ? "Your note, mid-task" : "Your note to the task"}</span>
      <div className="max-w-[80%] rounded-3xl bg-bubble px-4 py-2.5 text-chat whitespace-pre-wrap text-fg [overflow-wrap:anywhere] sm:max-w-[70%]">
        {messageText(message)}
      </div>
    </div>
  );
}

export const UserMessage = memo(function UserMessage({ message }: { message: Message }) {
  const { copied, copy } = useCopy();
  const text = messageText(message);
  if (message.auto) return <AutoDivider text={text} />;
  if (message.steered) return <SteerNote message={message} />;
  const pending = message.id.startsWith("local-");
  const files = message.parts.filter(
    (part): part is Extract<MessagePart, { type: "file" }> => part.type === "file",
  );

  return (
    <div className="group/message flex flex-col items-end">
      {files.length > 0 && (
        <div className={clsx("mb-1.5 flex max-w-[80%] flex-wrap justify-end gap-2 sm:max-w-[70%]", pending && "opacity-70")}>
          {files.map(({ id, attachment }) =>
            isImageMime(attachment.mimeType) ? (
              <ImageAttachment key={id} attachment={attachment} />
            ) : (
              <FileAttachment key={id} attachment={attachment} />
            ),
          )}
        </div>
      )}
      {text && (
        <div
          className={clsx(
            "max-w-[80%] rounded-3xl bg-bubble px-4 py-2.5 text-chat whitespace-pre-wrap text-fg [overflow-wrap:anywhere] transition-opacity sm:max-w-[70%]",
            pending && "opacity-70",
          )}
        >
          {text}
        </div>
      )}
      <div className="mt-1 flex h-7 opacity-0 transition-opacity group-hover/message:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100">
        {text && (
          <Tip content={copied ? "Copied" : "Copy"}>
            <IconButton label="Copy message" size="sm" onClick={() => void copy(text)}>
              {copied ? <Check /> : <Copy />}
            </IconButton>
          </Tip>
        )}
      </div>
    </div>
  );
});
