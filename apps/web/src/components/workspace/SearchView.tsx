import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { CaseSensitive, LoaderCircle, Regex } from "lucide-react";
import type { WorkspaceSearch } from "@tot/shared/workspace";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { errorMessage } from "../../lib/api";
import { workspaceApi } from "../../lib/workspace";
import { EmptyState } from "../ui/EmptyState";
import { IconButton } from "../ui/IconButton";
import { Tip } from "../ui/Tip";

type Found = { status: "idle" } | { status: "searching" } | { status: "error"; message: string } | { status: "ready"; result: WorkspaceSearch };

/** ⌘⇧F: text across the chat's folder (ripgrep when it's installed), matches grouped by file; one opens at its line. */
export function SearchView({ chatId, onOpen }: { chatId: string; onOpen: (path: string, line: number) => void }) {
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [found, setFound] = useState<Found>({ status: "idle" });
  const debounced = useDebouncedValue(query, 250);

  useEffect(() => {
    if (!debounced.trim()) {
      setFound({ status: "idle" });
      return;
    }
    let live = true;
    setFound({ status: "searching" });
    workspaceApi.search(chatId, debounced, { regex, caseSensitive }).then(
      (result) => live && setFound({ status: "ready", result }),
      (error) => live && setFound({ status: "error", message: errorMessage(error) }),
    );
    return () => {
      live = false;
    };
  }, [chatId, debounced, regex, caseSensitive]);

  const groups = useMemo(() => {
    const byFile = new Map<string, WorkspaceSearch["hits"]>();
    if (found.status === "ready") for (const hit of found.result.hits) byFile.set(hit.path, [...(byFile.get(hit.path) ?? []), hit]);
    return [...byFile];
  }, [found]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-0.5 border-b border-hairline py-1.5 pr-1 pl-2.5">
        <input
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search files"
          aria-label="Search in files"
          className="h-7 min-w-0 flex-1 bg-transparent text-ui text-fg outline-none placeholder:text-fg-subtle"
        />
        {found.status === "searching" && <LoaderCircle className="size-3.5 shrink-0 animate-spin text-fg-subtle" />}
        <Tip content="Match case">
          <IconButton size="sm" label="Match case" aria-pressed={caseSensitive} onClick={() => setCaseSensitive(!caseSensitive)}>
            <CaseSensitive />
          </IconButton>
        </Tip>
        <Tip content="Regular expression">
          <IconButton size="sm" label="Regular expression" aria-pressed={regex} onClick={() => setRegex(!regex)}>
            <Regex />
          </IconButton>
        </Tip>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {found.status === "error" ? (
          <p className="px-2 py-2 text-xs text-danger">{found.message}</p>
        ) : found.status === "ready" && groups.length === 0 ? (
          <EmptyState variant="quiet" title={`Nothing matches “${debounced}”`} />
        ) : found.status === "idle" ? (
          <EmptyState variant="quiet" title="Text in any file of this folder" />
        ) : (
          groups.map(([path, hits]) => (
            <div key={path} className="mb-1">
              <p className="truncate px-2 pt-1.5 pb-0.5 text-xs font-medium text-fg-muted" title={path}>
                {path}
              </p>
              {hits.map((hit) => (
                <button
                  key={`${hit.line}:${hit.column}`}
                  type="button"
                  onClick={() => onOpen(hit.path, hit.line)}
                  className="flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left font-mono text-xs text-fg-subtle transition-colors hover:bg-hover hover:text-fg"
                >
                  <span className="w-7 shrink-0 text-right tabular-nums">{hit.line}</span>
                  <span className={clsx("min-w-0 truncate text-fg-muted")}>{hit.text.trim()}</span>
                </button>
              ))}
            </div>
          ))
        )}
        {found.status === "ready" && found.result.truncated && <p className="px-2 py-2 text-xs text-fg-subtle">Showing the first {found.result.hits.length} matches.</p>}
      </div>
    </div>
  );
}
