import { useEffect, useId, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { Dialog } from "radix-ui";
import { CornerDownLeft, FileText, Hash, Search as SearchIcon } from "lucide-react";
import { SEARCH, normalize, score, type SearchEntry } from "./content";
import { hrefFor, navigate } from "./router";

function results(query: string): SearchEntry[] {
  const words = normalize(query).split(/\s+/).filter(Boolean);
  if (!words.length) return SEARCH.filter((entry) => !entry.heading);
  return SEARCH.map((entry) => ({ entry, rank: score(entry, words) }))
    .filter(({ rank }) => rank > 0)
    .sort((a, b) => b.rank - a.rank)
    .slice(0, 12)
    .map(({ entry }) => entry);
}

/** The typed query picked out in a result's label. */
function Marked({ text, query }: { text: string; query: string }) {
  const at = query ? normalize(text).indexOf(normalize(query)) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-sm bg-accent-soft text-fg">{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
}

/** ⌘K: a quick filter over page titles and headings. Arrows move, Enter opens, Esc closes. */
export function Search({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();
  const found = useMemo(() => results(query.trim()), [query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
  }, [open]);

  useEffect(() => {
    const row = list.current?.querySelector<HTMLElement>('[data-active="true"]');
    row?.scrollIntoView({ block: "nearest" });
  }, [active, found]);

  function go(entry: SearchEntry) {
    onOpenChange(false);
    navigate(hrefFor(entry.page.slug, entry.heading?.id));
  }

  const optionId = (entry: SearchEntry) => `${listId}-${entry.key.replace(/[^a-z0-9]+/gi, "-")}`;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-scrim/20 data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in" />
        <Dialog.Content
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (event.currentTarget as HTMLElement).querySelector("input")?.focus();
          }}
          className="fixed top-3 left-1/2 z-50 flex max-h-[min(560px,calc(100dvh-24px))] w-[calc(100vw-24px)] max-w-xl -translate-x-1/2 flex-col overflow-hidden rounded-2xl border border-edge bg-elevated shadow-dialog data-[state=closed]:animate-pop-out data-[state=open]:animate-pop-in sm:top-[12vh]"
        >
          <Dialog.Title className="sr-only">Search the docs</Dialog.Title>
          <div className="flex h-14 shrink-0 items-center gap-3 border-b border-hairline px-4">
            <SearchIcon className="size-4.5 shrink-0 text-fg-subtle" />
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setActive((index) => Math.min(index + 1, found.length - 1));
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setActive((index) => Math.max(index - 1, 0));
                } else if (event.key === "Enter" && found[active]) {
                  event.preventDefault();
                  go(found[active]);
                }
              }}
              placeholder="Search the docs"
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={found[active] ? optionId(found[active]) : undefined}
              className="h-full min-w-0 flex-1 bg-transparent text-[15px] text-fg outline-none placeholder:text-fg-subtle"
            />
            <kbd className="rounded-md border border-edge px-1.5 py-0.5 text-2xs font-medium text-fg-subtle">Esc</kbd>
          </div>
          <div ref={list} id={listId} role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto p-2">
            {!query.trim() && <p className="group-label px-2.5 pt-1 pb-2">Pages</p>}
            {found.length === 0 && <p className="px-3 py-10 text-center text-sm text-fg-subtle">Nothing matches “{query.trim()}”</p>}
            {found.map((entry, index) => {
              const Icon = entry.heading ? Hash : FileText;
              return (
                <button
                  key={entry.key}
                  id={optionId(entry)}
                  type="button"
                  role="option"
                  aria-selected={index === active}
                  data-active={index === active}
                  onMouseMove={() => setActive(index)}
                  onClick={() => go(entry)}
                  className={clsx(
                    "flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left transition-colors",
                    index === active ? "bg-selected" : "hover:bg-hover",
                  )}
                >
                  <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-hairline bg-fill-subtle text-fg-muted">
                    <Icon className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-fg">
                      <Marked text={entry.label} query={query.trim()} />
                    </span>
                    <span className="block truncate text-xs text-fg-subtle">{entry.hint}</span>
                  </span>
                  {index === active && <CornerDownLeft className="size-3.5 shrink-0 text-fg-subtle" />}
                </button>
              );
            })}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
