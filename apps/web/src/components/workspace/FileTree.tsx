import { useMemo, useState, type ReactNode } from "react";
import clsx from "clsx";
import { ChevronRight } from "lucide-react";
import { VirtualList } from "./VirtualList";

const ROW = 28;
const INDENT = 12;

interface Folder {
  name: string;
  path: string;
  folders: Map<string, Folder>;
  files: string[];
}

type Row = { kind: "folder"; path: string; name: string; depth: number; open: boolean } | { kind: "file"; path: string; name: string; depth: number };

function build(paths: string[]): Folder {
  const root: Folder = { name: "", path: "", folders: new Map(), files: [] };
  for (const path of paths) {
    const parts = path.split("/");
    let folder = root;
    for (const part of parts.slice(0, -1)) {
      let next = folder.folders.get(part);
      if (!next) {
        next = { name: part, path: folder.path ? `${folder.path}/${part}` : part, folders: new Map(), files: [] };
        folder.folders.set(part, next);
      }
      folder = next;
    }
    folder.files.push(path);
  }
  return root;
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

/** The rows on screen: folders first, a folder with nothing but one folder in it shown as one row ("src/lib"). */
function flatten(root: Folder, isOpen: (path: string) => boolean): Row[] {
  const rows: Row[] = [];
  const walk = (folder: Folder, depth: number) => {
    for (const child of [...folder.folders.values()].sort((a, b) => byName(a.name, b.name))) {
      let shown = child;
      let name = child.name;
      while (shown.files.length === 0 && shown.folders.size === 1) {
        shown = [...shown.folders.values()][0]!;
        name += `/${shown.name}`;
      }
      const open = isOpen(shown.path);
      rows.push({ kind: "folder", path: shown.path, name, depth, open });
      if (open) walk(shown, depth + 1);
    }
    for (const path of [...folder.files].sort((a, b) => byName(a.split("/").pop()!, b.split("/").pop()!))) {
      rows.push({ kind: "file", path, name: path.split("/").pop()!, depth });
    }
  };
  walk(root, 0);
  return rows;
}

/** The files in the order the tree shows them with every folder open. */
export function treeOrder(paths: string[]): string[] {
  return flatten(build(paths), () => true).flatMap((row) => (row.kind === "file" ? [row.path] : []));
}

/**
 * Paths as a tree of folders, virtualized (a repo's every file stays fast). Folders open or close on click;
 * `expanded` sets how they start. The selected file's folders open when it's selected from elsewhere (⌘P).
 */
export function FileTree({
  paths,
  selected,
  onOpen,
  trailing,
  expanded = true,
  label,
  className,
}: {
  paths: string[];
  selected: string | null;
  onOpen: (path: string) => void;
  trailing?: (path: string) => ReactNode;
  expanded?: boolean;
  label: string;
  className?: string;
}) {
  const root = useMemo(() => build(paths), [paths]);
  /** Folders flipped from how they start. */
  const [flipped, setFlipped] = useState<Set<string>>(() => new Set());
  const [revealed, setRevealed] = useState<string | null>(null);

  // A file chosen elsewhere: its folders open (once per choice, so they can be closed again).
  if (selected && selected !== revealed) {
    setRevealed(selected);
    const next = new Set(flipped);
    const parts = selected.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) {
      const folder = parts.slice(0, i).join("/");
      if (expanded) next.delete(folder);
      else next.add(folder);
    }
    setFlipped(next);
  }

  const rows = useMemo(() => flatten(root, (path) => expanded !== flipped.has(path)), [root, flipped, expanded]);
  const selectedIndex = selected ? rows.findIndex((row) => row.kind === "file" && row.path === selected) : -1;
  const scrollTo = useMemo(() => (selectedIndex >= 0 ? { index: selectedIndex } : null), [selectedIndex]);

  const toggle = (path: string) =>
    setFlipped((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  return (
    <VirtualList
      label={label}
      count={rows.length}
      rowHeight={ROW}
      scrollTo={scrollTo}
      className={clsx("px-1.5", className)}
      renderRow={(index) => {
        const row = rows[index]!;
        const isSelected = row.kind === "file" && row.path === selected;
        return (
          <button
            type="button"
            title={row.path}
            onClick={() => (row.kind === "folder" ? toggle(row.path) : onOpen(row.path))}
            aria-expanded={row.kind === "folder" ? row.open : undefined}
            aria-current={isSelected ? "true" : undefined}
            style={{ paddingLeft: 6 + row.depth * INDENT }}
            className={clsx(
              "flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md pr-2 text-left text-ui transition-colors focus-visible:-outline-offset-2",
              isSelected ? "bg-selected text-fg" : "text-fg-muted hover:bg-hover hover:text-fg",
            )}
          >
            {row.kind === "folder" ? (
              <ChevronRight className={clsx("size-3.5 shrink-0 text-fg-subtle transition-transform duration-150", row.open && "rotate-90")} />
            ) : (
              <span className="size-3.5 shrink-0" />
            )}
            <span className={clsx("min-w-0 flex-1 truncate", row.kind === "file" && isSelected && "font-medium")}>{row.name}</span>
            {row.kind === "file" && trailing?.(row.path)}
          </button>
        );
      }}
    />
  );
}
