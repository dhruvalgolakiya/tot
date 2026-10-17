import { useMemo } from "react";
import clsx from "clsx";
import { highlightLine, languageFor } from "./highlight";
import { VirtualList } from "./VirtualList";

const ROW = 20;

type Line = { kind: "add" | "del" | "ctx"; text: string; old: number | null; new: number | null };
type Row = { kind: "hunk" | "note"; text: string } | Line;

const isLine = (row: Row): row is Line => row.kind === "add" || row.kind === "del" || row.kind === "ctx";

/** A unified diff as rows: hunk headers, then its lines numbered on each side; rename and mode notes kept. */
export function parsePatch(patch: string): Row[] {
  const rows: Row[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(line);
    if (hunk) {
      inHunk = true;
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      rows.push({ kind: "hunk", text: line });
    } else if (line.startsWith("diff --git ")) {
      inHunk = false;
    } else if (!inHunk) {
      if (/^(rename|copy) (from|to) |^(new|deleted) file mode |^old mode |^new mode |^Binary files /.test(line)) rows.push({ kind: "note", text: line });
    } else if (line.startsWith("+")) {
      rows.push({ kind: "add", text: line.slice(1), old: null, new: newLine++ });
    } else if (line.startsWith("-")) {
      rows.push({ kind: "del", text: line.slice(1), old: oldLine++, new: null });
    } else if (line.startsWith(" ")) {
      rows.push({ kind: "ctx", text: line.slice(1), old: oldLine++, new: newLine++ });
    } else if (line.startsWith("\\")) {
      rows.push({ kind: "note", text: line.slice(2) });
    }
  }
  return rows;
}

/** One file's diff, virtualized and highlighted line by line as rows come into view. */
export function DiffView({ path, patch }: { path: string; patch: string }) {
  const rows = useMemo(() => parsePatch(patch), [patch]);
  const language = languageFor(path);
  const html = useMemo(() => new Map<number, string>(), [rows, language]);
  const digits = String(rows.reduce((max, row) => Math.max(max, isLine(row) ? Math.max(row.old ?? 0, row.new ?? 0) : 0), 0)).length;
  const widest = rows.reduce((max, row) => Math.max(max, row.text.length), 0);

  return (
    <VirtualList
      label={`Changes in ${path}`}
      count={rows.length}
      rowHeight={ROW}
      width={`calc(${widest + digits * 2 + 6}ch + 2rem)`}
      className="ws-code flex-1 text-xs"
      renderRow={(index) => {
        const row = rows[index]!;
        if (!isLine(row)) {
          return (
            <div className="flex h-5 items-center bg-fill-subtle px-3 whitespace-pre text-fg-subtle">
              {row.text}
            </div>
          );
        }
        let code = html.get(index);
        if (code === undefined) html.set(index, (code = highlightLine(row.text, language)));
        return (
          <div className={clsx("flex h-5 items-center leading-5 whitespace-pre", row.kind === "add" ? "bg-success-soft" : row.kind === "del" ? "bg-danger-soft" : "")}>
            <span className="shrink-0 pl-2 text-right text-fg-faint tabular-nums select-none" style={{ width: `${digits + 1}ch` }}>
              {row.old ?? ""}
            </span>
            <span className="shrink-0 pl-2 text-right text-fg-faint tabular-nums select-none" style={{ width: `${digits + 1}ch` }}>
              {row.new ?? ""}
            </span>
            <span className={clsx("w-6 shrink-0 text-center select-none", row.kind === "add" ? "text-success" : row.kind === "del" ? "text-danger" : "text-fg-faint")}>
              {row.kind === "add" ? "+" : row.kind === "del" ? "−" : ""}
            </span>
            <span className="pr-4 text-fg" dangerouslySetInnerHTML={{ __html: code }} />
          </div>
        );
      }}
    />
  );
}
