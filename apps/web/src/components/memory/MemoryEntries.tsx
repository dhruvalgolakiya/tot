import { useCallback, useEffect, useState } from "react";
import { Plus } from "lucide-react";
import type { Memory, MemoryFile } from "@tot/shared/types";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { api, errorMessage } from "../../lib/api";
import { memoryProse, useMemoryUi } from "../../lib/memory";
import { notifyError } from "../../store";
import { LazyMarkdown } from "../LazyMarkdown";
import { MemoryItem } from "../MemoryItem";
import { Button } from "../ui/Button";
import { Callout } from "../ui/Callout";
import { EmptyState } from "../ui/EmptyState";
import { Kbd } from "../ui/Kbd";
import { LedgerHeader, LedgerPanel } from "../ui/Ledger";
import { SearchInput } from "../ui/SearchInput";
import { SectionHeader } from "../ui/SectionHeader";
import { Skeleton } from "../ui/Skeleton";

/**
 * A memory repo's entries (roadmap module 10): add one, search them, and MEMORY.md (loaded in every chat) on
 * top, its prose rendered, then every other file's entries. Edit and delete on hover. `compact` (a project's
 * Facts in the Knowledge page) adds with a one-line field (Enter adds) and drops the headings and MEMORY.md's prose.
 */
export function MemoryEntries({
  repo,
  kind,
  onChanged,
  compact = false,
}: {
  repo: string;
  kind: "you" | "project";
  onChanged: () => void;
  compact?: boolean;
}) {
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
      {compact ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            disabled={adding}
            placeholder={kind === "you" ? "Add something about you and press Enter, e.g. “I prefer short answers.”" : "Add a fact and press Enter, e.g. “Tests need TZ=UTC.”"}
            aria-label="New fact"
            className="input"
          />
        </form>
      ) : (
        <>
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
        </>
      )}

      {total > (compact ? 8 : 0) && <SearchInput value={query} onChange={(event) => setQuery(event.target.value)} placeholder={compact ? "Search facts" : "Search memories"} aria-label={compact ? "Search facts" : "Search memories"} />}

      {loadError && !files && <Callout tone="danger">{loadError}</Callout>}
      {!loadError && !files && (
        <div className="space-y-2" aria-busy="true" aria-label="Loading memories">
          <Skeleton className="h-28 rounded-xl" />
          <Skeleton className="h-16 rounded-xl" />
        </div>
      )}

      {files && results && (
        results.length ? (
          <LedgerPanel body="fields">
            <ul>
              {results.map((memory, index) => (
                <MemoryItem key={`${memory.path}:${memory.id}`} memory={memory} first={index === 0} showPath onUpdated={changed} onDeleted={changed} />
              ))}
            </ul>
          </LedgerPanel>
        ) : (
          <EmptyState variant="quiet" title={`No memories match “${search}”.`} />
        )
      )}

      {files && !results && (
        <div className="space-y-3">
          <LedgerPanel
            body="fields"
            header={<LedgerHeader title={<span className="font-mono">MEMORY.md</span>} meta={compact ? main?.entries.length ?? 0 : `${main?.entries.length ?? 0} · Loaded in every chat`} />}
          >
            {prose && !compact && (
              <div className="px-4 py-3">
                <LazyMarkdown text={prose} muted />
              </div>
            )}
            {main?.entries.length ? (
              <ul>
                {main.entries.map((memory, index) => (
                  <MemoryItem key={memory.id} memory={memory} first={index === 0} onUpdated={changed} onDeleted={changed} />
                ))}
              </ul>
            ) : (
              <p className="px-4 py-3 text-sm text-fg-muted">
                {compact ? "No facts yet. Add one above, or tell an agent to remember something." : "Nothing yet. Tell an agent to remember something, or add it above."}
              </p>
            )}
          </LedgerPanel>
          {topics.map((file) => (
            <LedgerPanel key={file.path} body="fields" header={<LedgerHeader title={<span className="font-mono">{file.path}</span>} meta={file.entries.length} />}>
              <ul>
                {file.entries.map((memory, index) => (
                  <MemoryItem key={memory.id} memory={memory} first={index === 0} onUpdated={changed} onDeleted={changed} />
                ))}
              </ul>
            </LedgerPanel>
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
