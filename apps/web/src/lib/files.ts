import type { ChatFiles } from "@tot/shared/types";
import { api } from "./api";

/**
 * Files a message names ("@src/cart.ts"): picked from the chat's working folder after "@", kept in the text as
 * `@path`, shown there as an inline chip, and sent as `files` so the agent gets them (small text ones inlined).
 */

/** Where the composer's "@" looks: the open chat's folder, or (a chat not sent yet) its project's main checkout. */
export type FilesTarget = { conversationId: string } | { projectId: string; agentId: string | null };

const MENU_LIMIT = 12;

/** The "@query" being typed before the caret, for a path (longer than a chat title's, slashes and dots included). */
export function fileMentionAt(text: string, caret: number): { start: number; query: string } | null {
  const match = /(^|\s)@([^\s@]{0,200})$/.exec(text.slice(0, caret));
  if (!match) return null;
  return { start: caret - match[2]!.length - 1, query: match[2]! };
}

export function searchFiles(target: FilesTarget, query: string): Promise<ChatFiles> {
  return "conversationId" in target
    ? api.listChatFiles(target.conversationId, query, MENU_LIMIT)
    : api.listProjectFiles(target.projectId, target.agentId, query, MENU_LIMIT);
}

/** A file's name and the folder it's in, for a menu row. */
export function splitPath(path: string): { name: string; folder: string } {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? { name: path, folder: "" } : { name: path.slice(slash + 1), folder: path.slice(0, slash) };
}

export type TextPiece = { text: string; file?: string };

/** The text in pieces, with each `@path` of a named file as its own piece (at a word start, as it was typed). */
export function mentionPieces(text: string, files: Iterable<string>): TextPiece[] {
  const names = [...new Set(files)].filter(Boolean).sort((a, b) => b.length - a.length);
  if (!names.length) return [{ text }];
  const escaped = names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const pattern = new RegExp(`(^|\\s)@(${escaped.join("|")})(?=$|[\\s,.;:!?)\\]])`, "g");
  const pieces: TextPiece[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index + match[1]!.length;
    if (start > last) pieces.push({ text: text.slice(last, start) });
    pieces.push({ text: `@${match[2]}`, file: match[2] });
    last = start + match[2]!.length + 1;
  }
  if (last < text.length) pieces.push({ text: text.slice(last) });
  return pieces;
}

/** The named files still in the text, in order (one removed by editing the text no longer goes). */
export function filesInText(text: string, files: Iterable<string>): string[] {
  return [...new Set(mentionPieces(text, files).flatMap((piece) => (piece.file ? [piece.file] : [])))];
}

/** A path dragged in (a file:// URL or an absolute path) inside the chat's folder on this Mac, relative to it; else null. */
export function droppedPath(data: string, root: string | null): string | null {
  if (!root) return null;
  const first = data.split(/\r?\n/).map((line) => line.trim()).find((line) => line && !line.startsWith("#"));
  if (!first) return null;
  let path = first;
  if (first.startsWith("file://")) {
    try {
      path = decodeURIComponent(new URL(first).pathname);
    } catch {
      return null;
    }
  }
  const base = root.replace(/\/+$/, "");
  return path.startsWith(`${base}/`) && path.length > base.length + 1 ? path.slice(base.length + 1) : null;
}
