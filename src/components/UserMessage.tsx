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
      className="block max-w-56 overflow-hidden rounded-2xl border border-white/10 transition-opacity hover:opacity-90"
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
      className="flex max-w-72 items-center gap-2.5 rounded-2xl border border-white/10 bg-white/[0.03] py-2 pr-3 pl-2.5 transition-colors hover:bg-white/[0.06]"
    >
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-white/[0.06]">
        <Icon className="size-4 text-zinc-400" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-zinc-200">{attachment.name}</span>
        <span className="block text-[11px] text-zinc-500">{formatBytes(attachment.size)}</span>
      </span>
      <Download className="size-3.5 shrink-0 text-zinc-500" />
    </a>
  );
}

export const UserMessage = memo(function UserMessage({ message }: { message: Message }) {
  const { copied, copy } = useCopy();
  const text = messageText(message);
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
            "max-w-[80%] rounded-3xl bg-bubble px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap text-white/92 [overflow-wrap:anywhere] transition-opacity sm:max-w-[70%]",
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
