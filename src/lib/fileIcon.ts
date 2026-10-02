import { File, FileArchive, FileAudio, FileCode, FileText, FileVideo, Image as ImageIcon, type LucideIcon } from "lucide-react";

export const isImageMime = (mimeType: string): boolean => mimeType.startsWith("image/");

/** A representative lucide icon for a file's mime type, for chips that aren't images. */
export function fileIcon(mimeType: string): LucideIcon {
  if (isImageMime(mimeType)) return ImageIcon;
  if (mimeType.startsWith("audio/")) return FileAudio;
  if (mimeType.startsWith("video/")) return FileVideo;
  if (/zip|compressed|tar|archive/.test(mimeType)) return FileArchive;
  if (mimeType === "application/pdf") return FileText;
  if (mimeType.startsWith("text/") || /json|javascript|typescript/.test(mimeType)) return FileCode;
  return File;
}
