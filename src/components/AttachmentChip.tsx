import { AlertCircle, LoaderCircle, X } from "lucide-react";
import { formatBytes } from "../lib/format";
import { fileIcon, isImageMime } from "../lib/fileIcon";
import type { PendingAttachment } from "../hooks/useAttachments";
import { IconButton } from "./ui/IconButton";

interface AttachmentChipProps {
  item: PendingAttachment;
  onRemove: (localId: string) => void;
}

/** One file in the composer's attachment tray: thumbnail or icon, upload state, and a remove button. */
export function AttachmentChip({ item, onRemove }: AttachmentChipProps) {
  const { file, status, attachment } = item;
  const mimeType = attachment?.mimeType ?? file.type;
  const name = attachment?.name ?? file.name;
  const size = attachment?.size ?? file.size;
  const thumbnail = status === "done" && attachment && isImageMime(mimeType) ? attachment.url : null;
  const Icon = fileIcon(mimeType);

  return (
    <div
      className="group/attachment relative flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-white/[0.03]"
      title={name}
    >
      {thumbnail ? (
        <img src={thumbnail} alt={name} className="size-full object-cover" />
      ) : (
        <div className="flex flex-col items-center gap-1 px-1">
          <Icon className="size-5 text-zinc-400" />
          <span className="max-w-14 truncate text-[9px] leading-tight text-zinc-500">{name}</span>
        </div>
      )}

      {status === "uploading" && (
        <div className="dark absolute inset-0 grid place-items-center bg-black/55">
          <LoaderCircle className="size-4 animate-spin text-zinc-200" />
        </div>
      )}
      {status === "error" && (
        <div className="absolute inset-0 grid place-items-center bg-red-950/70" title="Upload failed">
          <AlertCircle className="size-5 text-red-300" />
        </div>
      )}
      {status === "done" && !thumbnail && size > 0 && (
        <span className="dark absolute right-1 bottom-1 rounded bg-black/60 px-1 text-[8px] text-zinc-400">{formatBytes(size)}</span>
      )}

      <IconButton
        label={`Remove ${name}`}
        size="sm"
        onClick={() => onRemove(item.localId)}
        className="absolute -top-1.5 -right-1.5 size-5 border border-white/10 bg-zinc-900 text-zinc-300 opacity-0 shadow-sm transition-opacity group-hover/attachment:opacity-100 pointer-coarse:opacity-100 hover:bg-zinc-800 hover:text-zinc-100 focus-visible:opacity-100 [&_svg]:size-3"
      >
        <X />
      </IconButton>
    </div>
  );
}
