import type { MessagePart } from "@tot/shared/types";
import { toolDisplayStatus, type ToolPart } from "./tools";

/** Tools whose row shows something of its own (a screenshot, a shared link), and the memory and wiki pills: never in a group. */
const STANDALONE = new Set(["computer_screenshot", "computer_expose_port", "memory_save", "wiki_write", "wiki_edit"]);
const DESKTOP = new Set(["computer_click", "computer_type", "computer_key", "computer_scroll", "computer_open_url"]);

/**
 * One row of a reply: a part as it is, two or more finished tool calls in a row (with the thinking between them) as
 * one, or in an older turn its work before the answer, folded.
 */
export type PartRow = { kind: "part"; index: number } | { kind: "tools"; indexes: number[] } | { kind: "work"; indexes: number[] };

const PILL_TOOLS = new Set(["memory_save", "wiki_write", "wiki_edit"]);
const isToolRow = (part: MessagePart | undefined) => part?.type === "tool" && !PILL_TOOLS.has(part.name);

/** Tool rows stack tightly; everything else gets room to breathe. */
export function partSpacing(previous: MessagePart | undefined, part: MessagePart): string | undefined {
  if (!previous) return undefined;
  return isToolRow(previous) && isToolRow(part) ? "mt-1.5" : "mt-3";
}

/** A tool call that can fold into a group: finished fine, and with nothing of its own to show. Failed, running and interrupted ones stay out. */
function groupable(part: MessagePart | undefined, live: boolean): part is ToolPart {
  return part?.type === "tool" && !STANDALONE.has(part.name) && toolDisplayStatus(part, live) === "done";
}

/**
 * A reply's parts as rows: runs of two or more finished tool calls fold into one, along with any thinking between
 * them. A run ends at anything else (text, an approval, a failed call…), and after a part the user's note follows.
 */
export function partRows(parts: MessagePart[], { live, noteAfter }: { live: boolean; noteAfter: (partId: string) => boolean }): PartRow[] {
  const rows: PartRow[] = [];
  let i = 0;
  while (i < parts.length) {
    if (groupable(parts[i], live)) {
      let end = i;
      let tools = 1;
      for (let j = i; !noteAfter(parts[j]!.id) && j + 1 < parts.length; ) {
        const next = parts[j + 1]!;
        if (groupable(next, live)) {
          tools++;
          end = j = j + 1;
        } else if (next.type === "reasoning") {
          j += 1;
        } else {
          break;
        }
      }
      if (tools > 1) {
        rows.push({ kind: "tools", indexes: Array.from({ length: end - i + 1 }, (_, k) => i + k) });
        i = end + 1;
        continue;
      }
    }
    rows.push({ kind: "part", index: i });
    i++;
  }
  return rows;
}

/**
 * What an older turn folds: thinking, tool calls and approvals, and the text between them. Its answer, tasks, notices
 * and what a call showed (a screenshot, a shared link) stay.
 */
const WORK = new Set<MessagePart["type"]>(["reasoning", "tool", "approval"]);
const SHOWS = new Set(["computer_screenshot", "computer_expose_port"]);

/**
 * An older, finished reply's rows: its work from the first call or thought to the last folds into one row, so the
 * text it ends with (the answer) stays. Task cards, notices, screenshots and shared links stay in place and split the
 * fold; so does a note the user sent mid-turn, after the part it followed.
 */
export function foldedRows(parts: MessagePart[], { noteAfter }: { noteAfter: (partId: string) => boolean }): PartRow[] {
  const first = parts.findIndex((part) => WORK.has(part.type));
  const last = parts.findLastIndex((part) => WORK.has(part.type));
  if (first === -1) return partRows(parts, { live: false, noteAfter });
  const rows: PartRow[] = [];
  for (let i = 0; i < first; i++) rows.push({ kind: "part", index: i });
  let fold: number[] = [];
  const flush = () => {
    // One thing alone shows as it is (a group of its calls, if it's that).
    if (fold.length > 1) rows.push({ kind: "work", indexes: fold });
    else for (const index of fold) rows.push({ kind: "part", index });
    fold = [];
  };
  for (let i = first; i <= last; i++) {
    const part = parts[i]!;
    if (part.type === "task" || part.type === "notice" || (part.type === "tool" && SHOWS.has(part.name))) {
      flush();
      rows.push({ kind: "part", index: i });
      continue;
    }
    fold.push(i);
    if (noteAfter(part.id)) flush();
  }
  flush();
  for (let i = last + 1; i < parts.length; i++) rows.push({ kind: "part", index: i });
  return rows;
}

/** What a tool call counts as in a group's summary: "ran 2 commands", "read 4 files"… */
function kindOf(part: ToolPart): { verb: string; one: string; many: string; distinct?: string } {
  const input = part.input && typeof part.input === "object" ? (part.input as Record<string, unknown>) : {};
  const path = typeof input.path === "string" ? input.path : undefined;
  if (part.name === "computer_exec" || part.name === "shell") return { verb: "ran", one: "command", many: "commands" };
  if (part.name === "computer_read_file" || part.name === "github/get_file_contents" || (part.name === "skill_read" && path)) {
    return { verb: "read", one: "file", many: "files", distinct: path };
  }
  if (part.name === "computer_write_file" || part.name === "github/create_or_update_file") return { verb: "edited", one: "file", many: "files", distinct: path };
  if (part.name.endsWith("_search") || part.name.startsWith("github/search_")) return { verb: "made", one: "search", many: "searches" };
  if (part.name === "web_fetch" || part.name === "wiki_read" || part.name === "chat_read") return { verb: "read", one: "page", many: "pages" };
  if (DESKTOP.has(part.name)) return { verb: "took", one: "desktop step", many: "desktop steps" };
  return { verb: "used", one: "tool", many: "tools" };
}

/** A group's one line, e.g. "Read 4 files, ran 2 commands, edited 3 files" (the same file read twice counts once). */
export function toolsSummary(parts: MessagePart[]): string {
  // Verb → noun → its paths and the calls that named none, each in the order first seen.
  const verbs = new Map<string, Map<string, { one: string; many: string; paths: Set<string>; unnamed: number }>>();
  for (const part of parts) {
    if (part.type !== "tool") continue;
    const kind = kindOf(part);
    const nouns = verbs.get(kind.verb) ?? new Map();
    verbs.set(kind.verb, nouns);
    const count = nouns.get(kind.one) ?? { one: kind.one, many: kind.many, paths: new Set<string>(), unnamed: 0 };
    nouns.set(kind.one, count);
    if (kind.distinct) count.paths.add(kind.distinct);
    else count.unnamed++;
  }
  const phrases = [...verbs].map(([verb, nouns]) => {
    const counted = [...nouns.values()].map(({ one, many, paths, unnamed }) => {
      const n = paths.size + unnamed;
      return `${n} ${n === 1 ? one : many}`;
    });
    return `${verb} ${counted.join(" and ")}`;
  });
  const line = phrases.join(", ");
  return line.charAt(0).toUpperCase() + line.slice(1);
}
