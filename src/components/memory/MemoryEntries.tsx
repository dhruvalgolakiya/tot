import { useCallback, useEffect, useState } from "react";
import { Plus } from "lucide-react";
import type { Memory, MemoryFile } from "@shared/types";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { api, errorMessage } from "../../lib/api";
import { memoryProse, useMemoryUi } from "../../lib/memory";
import { notifyError } from "../../store";
import { LazyMarkdown } from "../LazyMarkdown";
import { MemoryItem } from "../MemoryItem";
import { Button } from "../ui/Button";
import { Callout } from "../ui/Callout";
import { cardClass } from "../ui/Card";
import { EmptyState } from "../ui/EmptyState";
import { Kbd } from "../ui/Kbd";
import { SearchInput } from "../ui/SearchInput";
import { SectionHeader } from "../ui/SectionHeader";
import { Skeleton } from "../ui/Skeleton";

/**
 * A memory repo's entries (roadmap module 10): add one, search them, and MEMORY.md (loaded in every chat) on
 * top, its prose rendered, then every other file's entries. Edit and delete on hover.
 */
export function MemoryEntries({ repo, kind, onChanged }: { repo: string; kind: "you" | "project"; onChanged: () => void }) {
  const version = useMemoryUi((s) => s.versions[repo] ?? 0);
  const [files, setFiles] = useState<MemoryFile[] | null>(null);
  const [entryFile, setEntryFile] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const search = useDebouncedValue(query.trim(), 250);
  const [results, setResults] = useState<Memory[] | null>(null);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const [list, main] = await Promise.all([api.memoryFiles(repo), api.memoryFile(repo, "MEMORY.md").catch(() => null)]);
      setFiles(list);
      setEntryFile(main?.content ?? "");
      setLoadError(null);
    } catch (error) {
      setLoadError(errorMessage(error));
    }
  }, [repo]);

  useEffect(() => {
    void load();
  }, [load, version]);

  useEffect(() => {
    if (!search) {
      setResults(null);
      return;
    }
    let cancelled = false;
    api.listMemories({ q: search, repo }).then(
      (list) => !cancelled && setResults(list),
      (error: unknown) => !cancelled && notifyError(error),
    );
    return () => {
      cancelled = true;
    };
  }, [search, repo, version]);

  const changed = () => {
    void load();
    onChanged();
  };

  async function add() {
    const content = draft.trim();
    if (!content) return;
    setAdding(true);
    try {
      await api.createMemory(content, { repo });
      setDraft("");
      changed();
    } catch (error) {
      notifyError(error);
    } finally {
      setAdding(false);
    }
  }

  const markdown = files?.filter((file) => file.markdown) ?? [];
  const others = files?.filter((file) => !file.markdown) ?? [];
  const main = markdown.find((file) => file.path === "MEMORY.md");
  const topics = markdown.filter((file) => file.path !== "MEMORY.md" && file.entries.length);
  const prose = memoryProse(entryFile);
  const total = markdown.reduce((sum, file) => sum + file.entries.length, 0);

  return (
    <section className="space-y-3">
      <SectionHeader title="Entries" description={kind === "you" ? "One short fact per line, about you." : "One short fact per line, about this project's code and work."} />
      <form
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
          placeholder={kind === "you" ? "Add something for TOT to remember, e.g. “I live in Berlin and work in UTC+1.”" : "Add something agents should know here, e.g. “Tests need TZ=UTC.”"}
          aria-label="New memory"
          className="input resize-none rounded-xl leading-relaxed"
        />
        <div className="mt-2 flex items-center justify-end gap-3">
          <span className="hidden text-xs text-fg-faint sm:inline">
            <Kbd keys={["mod", "↵"]} /> to add
          </span>
          <Button type="submit" size="sm" variant="primary" disabled={adding || !draft.trim()}>
            <Plus /> {adding ? "Adding…" : "Add memory"}
          </Button>
        </div>
      </form>

      {total > 0 && <SearchInput value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search memories" aria-label="Search memories" />}

      {loadError && !files && <Callout tone="danger">{loadError}</Callout>}
      {!loadError && !files && (
        <div className="space-y-2" aria-busy="true" aria-label="Loading memories">
          <Skeleton className="h-28 rounded-xl" />
          <Skeleton className="h-16 rounded-xl" />
        </div>
      )}

      {files && results && (
        results.length ? (
          <ul className={cardClass({ padding: "none" })}>
            {results.map((memory, index) => (
              <MemoryItem key={`${memory.path}:${memory.id}`} memory={memory} first={index === 0} showPath onUpdated={changed} onDeleted={changed} />
            ))}
          </ul>
        ) : (
          <EmptyState size="sm" variant="dashed" description={`No memories match “${search}”.`} />
        )
      )}

      {files && !results && (
        <div className="space-y-3">
          <div className={cardClass({ padding: "none" })}>
            <FileHeader path="MEMORY.md" count={main?.entries.length ?? 0} note="Loaded in every chat" />
            {prose && (
              <div className="border-t border-hairline px-4 py-3">
                <LazyMarkdown text={prose} muted />
              </div>
            )}
            {main?.entries.length ? (
              <ul className="border-t border-hairline">
                {main.entries.map((memory, index) => (
                  <MemoryItem key={memory.id} memory={memory} first={index === 0} onUpdated={changed} onDeleted={changed} />
                ))}
              </ul>
            ) : (
              <p className="border-t border-hairline px-4 py-3 text-sm text-fg-muted">
                Nothing yet. Tell an agent to remember something, or add it above.
              </p>
            )}
          </div>
          {topics.map((file) => (
            <div key={file.path} className={cardClass({ padding: "none" })}>
              <FileHeader path={file.path} count={file.entries.length} />
              <ul className="border-t border-hairline">
                {file.entries.map((memory, index) => (
                  <MemoryItem key={memory.id} memory={memory} first={index === 0} onUpdated={changed} onDeleted={changed} />
                ))}
              </ul>
            </div>
          ))}
          {others.length > 0 && (
            <p className="text-xs text-fg-subtle">
              Also in this repo: <span className="font-mono">{others.map((file) => file.path).join(", ")}</span>
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function FileHeader({ path, count, note }: { path: string; count: number; note?: string }) {
  return (
    <div className="flex h-10 items-center gap-2 px-4">
      <span className="truncate font-mono text-ui text-fg">{path}</span>
      <span className="text-xs text-fg-subtle tabular-nums">{count}</span>
      {note && <span className="ml-auto shrink-0 text-xs text-fg-subtle">{note}</span>}
    </div>
  );
}
