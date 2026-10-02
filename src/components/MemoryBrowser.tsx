import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import type { Memory } from "@shared/types";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { api, errorMessage } from "../lib/api";
import { toMs } from "../lib/format";
import { goToSettings, notifyError, useStore } from "../store";
import { Button } from "./ui/Button";
import { Callout } from "./ui/Callout";
import { EmptyState } from "./ui/EmptyState";
import { Kbd } from "./ui/Kbd";
import { SearchInput } from "./ui/SearchInput";
import { Skeleton } from "./ui/Skeleton";
import { MemoryItem } from "./MemoryItem";

const newestFirst = (list: Memory[]) => [...list].sort((a, b) => toMs(b.createdAt) - toMs(a.createdAt));

/** Search, add, edit and delete memory about the user. */
export function MemoryBrowser() {
  const memoryEnabled = useStore((s) => s.settings?.memory.enabled ?? true);
  const [query, setQuery] = useState("");
  const search = useDebouncedValue(query.trim(), 250);
  const [memories, setMemories] = useState<Memory[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setMemories(null);
    setLoadError(null);
    api.listMemories({ q: search || undefined }).then(
      (list) => {
        if (cancelled) return;
        setMemories(newestFirst(list));
        setLoadError(null);
      },
      (error: unknown) => {
        if (!cancelled) setLoadError(errorMessage(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [search]);

  async function add() {
    const content = draft.trim();
    if (!content) return;
    setAdding(true);
    try {
      const memory = await api.createMemory(content);
      setMemories((list) => [memory, ...(list ?? [])]);
      setDraft("");
    } catch (error) {
      notifyError(error);
    } finally {
      setAdding(false);
    }
  }

  const replace = (memory: Memory) => setMemories((list) => list?.map((m) => (m.id === memory.id ? memory : m)) ?? null);
  const remove = (id: string) => setMemories((list) => list?.filter((m) => m.id !== id) ?? null);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!memoryEnabled && (
        <div className="mb-3">
          <Callout
            tone="warning"
            action={
              <button type="button" className="link-muted" onClick={() => goToSettings("general")}>
                Turn it on in Settings
              </button>
            }
          >
            Memory is off, so TOT won't save or recall anything.
          </Callout>
        </div>
      )}

      <form
        className="shrink-0 pb-3"
        onSubmit={(event) => {
          event.preventDefault();
          void add();
        }}
      >
        <textarea
          rows={2}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void add();
            }
          }}
          placeholder="Add something for TOT to remember, e.g. “I live in Berlin and work in UTC+1.”"
          aria-label="New memory"
          className="input resize-none leading-relaxed"
        />
        <div className="mt-2 flex items-center justify-end gap-3">
          <span className="hidden text-xs text-fg-faint sm:inline">
            <Kbd keys={["mod", "↵"]} /> to add
          </span>
          <Button type="submit" size="sm" variant="primary" disabled={adding || !draft.trim()}>
            <Plus /> Add memory
          </Button>
        </div>
      </form>

      <div className="shrink-0 pb-3">
        <SearchInput
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search memories"
          aria-label="Search memories"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-5">
        {loadError && !memories && <Callout tone="danger">{loadError}</Callout>}
        {!loadError && !memories && (
          <div className="space-y-2" aria-busy="true" aria-label="Loading memories">
            {[0, 1, 2].map((key) => (
              <Skeleton key={key} className="h-16 rounded-xl" />
            ))}
          </div>
        )}
        {memories && memories.length === 0 && (
          <EmptyState
            title={search ? `No memories match “${search}”.` : "Nothing yet"}
            description={search ? undefined : "Tell TOT to remember something, or add it here."}
          />
        )}
        {memories && memories.length > 0 && (
          <ul className="space-y-2">
            {memories.map((memory) => (
              <MemoryItem key={memory.id} memory={memory} onUpdated={replace} onDeleted={remove} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
