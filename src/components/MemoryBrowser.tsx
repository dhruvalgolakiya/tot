import { useEffect, useState } from "react";
import { Plus, Search } from "lucide-react";
import type { Memory } from "@shared/types";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { api, errorMessage } from "../lib/api";
import { toMs } from "../lib/format";
import { goToSettings, notifyError, useStore } from "../store";
import { Button } from "./ui/Button";
import { Kbd } from "./ui/Kbd";
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
        <div className="mx-5 mb-3 rounded-lg border border-amber-400/20 bg-amber-400/[0.06] px-3 py-2 text-xs text-amber-200">
          Memory is off, so TOT won't save or recall anything.{" "}
          <button
            type="button"
            className="font-medium underline-offset-2 hover:underline"
            onClick={() => goToSettings("general")}
          >
            Turn it on in Settings
          </button>
        </div>
      )}

      <form
        className="shrink-0 px-5 pb-3"
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
          <span className="hidden text-xs text-zinc-600 sm:inline">
            <Kbd keys={["mod", "↵"]} /> to add
          </span>
          <Button type="submit" size="sm" variant="primary" disabled={adding || !draft.trim()}>
            <Plus /> Add memory
          </Button>
        </div>
      </form>

      <div className="shrink-0 px-5 pb-3">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-zinc-500" />
          <input
            type="text"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search memories"
            aria-label="Search memories"
            className="input pl-9"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5">
        {loadError && !memories && <p className="py-8 text-center text-sm text-zinc-500">{loadError}</p>}
        {!loadError && !memories && (
          <div className="space-y-2" aria-label="Loading memories">
            {[0, 1, 2].map((key) => (
              <div key={key} className="h-16 animate-pulse rounded-xl bg-white/[0.03]" />
            ))}
          </div>
        )}
        {memories && memories.length === 0 && (
          <p className="py-8 text-center text-sm text-zinc-500">
            {search ? `No memories match “${search}”.` : "Nothing yet. Tell TOT to remember something, or add it here."}
          </p>
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
