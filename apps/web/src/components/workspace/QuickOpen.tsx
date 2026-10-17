import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import clsx from "clsx";
import { Kbd } from "../ui/Kbd";
import { fuzzyFind } from "./fuzzy";

/** A path with the matched letters in the file's own color. */
function Highlighted({ path, indexes }: { path: string; indexes: number[] }) {
  const nameStart = path.lastIndexOf("/") + 1;
  const marked = new Set(indexes);
  const part = (from: number, to: number, className: string) => (
    <span className={className}>
      {[...path.slice(from, to)].map((char, i) => (
        <span key={i} className={marked.has(from + i) ? "font-semibold text-fg" : undefined}>
          {char}
        </span>
      ))}
    </span>
  );
  return (
    <span className="flex min-w-0 items-baseline gap-2">
      {part(nameStart, path.length, "shrink-0 text-fg")}
      {nameStart > 0 && part(0, nameStart - 1, "min-w-0 truncate text-xs text-fg-subtle")}
    </span>
  );
}

/** ⌘P: the chat folder's files, found by a few letters of their names. Enter opens, Escape closes. */
export function QuickOpen({ paths, onOpen, onClose }: { paths: string[]; onOpen: (path: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const matches = useMemo(() => fuzzyFind(paths, query), [paths, query]);

  const move = (to: number) => {
    const next = Math.max(0, Math.min(matches.length - 1, to));
    setActive(next);
    listRef.current?.children[next]?.scrollIntoView({ block: "nearest" });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "ArrowDown" || (event.ctrlKey && event.key === "n")) move(active + 1);
    else if (event.key === "ArrowUp" || (event.ctrlKey && event.key === "p")) move(active - 1);
    else if (event.key === "Enter") {
      if (matches[active]) onOpen(matches[active].path);
    } else if (event.key === "Escape") onClose();
    else return;
    event.preventDefault();
  };

  return (
    <div className="absolute inset-x-3 top-2 z-20 animate-pop-in overflow-hidden rounded-xl border border-edge bg-elevated shadow-popover" data-own-escape>
      <input
        autoFocus
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
        onBlur={(event) => {
          if (!event.currentTarget.parentElement?.contains(event.relatedTarget)) onClose();
        }}
        placeholder="Go to file…"
        aria-label="Go to file"
        aria-controls="workspace-quick-open"
        className="h-10 w-full border-b border-hairline bg-transparent px-3 text-sm text-fg outline-none placeholder:text-fg-subtle"
      />
      <div ref={listRef} id="workspace-quick-open" role="listbox" className="max-h-80 overflow-y-auto p-1">
        {matches.length === 0 ? (
          <p className="px-2 py-2 text-ui text-fg-subtle">No files match “{query}”</p>
        ) : (
          matches.map((match, index) => (
            <button
              key={match.path}
              type="button"
              role="option"
              aria-selected={index === active}
              tabIndex={-1}
              onMouseMove={() => setActive(index)}
              onClick={() => onOpen(match.path)}
              className={clsx("flex h-8 w-full items-center rounded-lg px-2 text-left text-ui", index === active ? "bg-selected" : "hover:bg-hover")}
            >
              <Highlighted path={match.path} indexes={match.indexes} />
            </button>
          ))
        )}
      </div>
      <div className="flex items-center gap-3 border-t border-hairline px-3 py-1.5 text-2xs text-fg-subtle">
        <span className="flex items-center gap-1">
          <Kbd keys={["↑"]} /> <Kbd keys={["↓"]} /> to move
        </span>
        <span className="flex items-center gap-1">
          <Kbd keys={["↵"]} /> to open
        </span>
      </div>
    </div>
  );
}
