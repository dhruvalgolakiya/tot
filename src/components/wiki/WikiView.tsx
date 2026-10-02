import { useEffect, useMemo, useRef, useState } from "react";
import { PanelLeft } from "lucide-react";
import type { WikiPage, WikiPageSummary, WikiSearchHit } from "@shared/types";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { DESKTOP_QUERY, useMediaQuery, XL_QUERY } from "../../hooks/useMediaQuery";
import { api, errorMessage } from "../../lib/api";
import { extractHeadings } from "../../lib/wiki";
import { openWikiPage, selectActiveAgent, useStore } from "../../store";
import { Button } from "../ui/Button";
import { Modal } from "../ui/Modal";
import { LearnRepoDialog } from "./LearnRepoDialog";
import { WikiEmptyState } from "./WikiEmptyState";
import { WikiOutline } from "./WikiOutline";
import { WikiPageView } from "./WikiPageView";
import { WikiTree } from "./WikiTree";

/**
 * Wiki view: a page tree on the left, the open page in the middle, an optional
 * "On this page" outline on very wide screens. Mounted in the main card in
 * place of ChatView while `page === "wiki"` (see App.tsx and store.ts).
 */
export function WikiView() {
  const agent = useStore(selectActiveAgent);
  const agentId = agent?.id ?? null;
  const wikiPageId = useStore((s) => s.wikiPageId);
  const wikiEvent = useStore((s) => s.wikiEvent);
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const xlWide = useMediaQuery(XL_QUERY);

  const [pages, setPages] = useState<WikiPageSummary[] | null>(null);
  const [pagesError, setPagesError] = useState<string | null>(null);
  const [page, setPage] = useState<WikiPage | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [mobileTreeOpen, setMobileTreeOpen] = useState(false);
  const [learnOpen, setLearnOpen] = useState(false);

  const [query, setQuery] = useState("");
  const search = useDebouncedValue(query.trim(), 250);
  const [searchHits, setSearchHits] = useState<WikiSearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);

  const contentRef = useRef<HTMLDivElement>(null);

  const activePageId = wikiPageId ?? pages?.[0]?.id ?? null;

  function loadPages(id: string) {
    api.listWikiPages(id).then(
      (list) => {
        setPages(list);
        setPagesError(null);
      },
      (error: unknown) => setPagesError(errorMessage(error)),
    );
  }

  function refetchActivePage(id: string) {
    api.getWikiPage(id).then(setPage, (error: unknown) => setPageError(errorMessage(error)));
  }

  // Load this agent's wiki fresh whenever the active agent changes.
  useEffect(() => {
    if (!agentId) return;
    setPages(null);
    setPagesError(null);
    setPage(null);
    setPageError(null);
    setEditing(false);
    setQuery("");
    loadPages(agentId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload keyed only on the agent
  }, [agentId]);

  // Fetch the open page whenever it changes (but not when we already have it,
  // e.g. right after creating one — see `createPage`).
  useEffect(() => {
    if (!activePageId) {
      setPage(null);
      return;
    }
    if (page?.id === activePageId) return;
    let cancelled = false;
    setPage(null);
    setPageError(null);
    setEditing(false);
    api.getWikiPage(activePageId).then(
      (loaded) => {
        if (!cancelled) setPage(loaded);
      },
      (error: unknown) => {
        if (!cancelled) setPageError(errorMessage(error));
      },
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `page` is read only to skip a redundant fetch
  }, [activePageId]);

  // A tool call or the background keeper changed this workspace's wiki: refresh
  // the tree, and the open page too — unless it's being edited right now.
  useEffect(() => {
    if (!agentId || !wikiEvent || wikiEvent.agentId !== agentId) return;
    loadPages(agentId);
    if (activePageId && !editing) refetchActivePage(activePageId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-run when a new event comes in
  }, [wikiEvent]);

  // Search the wiki instead of showing the tree once there's a query.
  useEffect(() => {
    if (!agentId || !search) {
      setSearchHits(null);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    api.searchWiki(agentId, search).then(
      (hits) => {
        if (!cancelled) {
          setSearchHits(hits);
          setSearching(false);
        }
      },
      () => {
        if (!cancelled) {
          setSearchHits([]);
          setSearching(false);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [agentId, search]);

  const headings = useMemo(() => (page ? extractHeadings(page.content) : []), [page]);

  if (!agent) {
    return <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">Loading…</div>;
  }

  function handleSelect(pageId: string) {
    openWikiPage(pageId);
    setMobileTreeOpen(false);
  }

  async function createPage() {
    try {
      const created = await api.createWikiPage(agent!.id, { title: "Untitled", content: "" });
      setPages((list) => (list ? [...list, created] : [created]));
      setPage(created);
      setEditing(true);
      openWikiPage(created.id);
      setMobileTreeOpen(false);
    } catch (error) {
      setPagesError(errorMessage(error));
    }
  }

  function handlePageChanged(updated: WikiPage) {
    setPage(updated);
    setPages(
      (list) =>
        list?.map((p) =>
          p.id === updated.id
            ? { ...p, title: updated.title, summary: updated.summary, updatedBy: updated.updatedBy, updatedAt: updated.updatedAt }
            : p,
        ) ?? list,
    );
  }

  function handlePageDeleted() {
    loadPages(agent!.id);
    openWikiPage(null);
  }

  function scrollToHeading(text: string) {
    const root = contentRef.current;
    if (!root) return;
    const target = Array.from(root.querySelectorAll<HTMLElement>("h2, h3")).find((el) => el.textContent?.trim() === text);
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const isEmptyWorkspace = pages !== null && pages.length === 1 && page !== null && !page.content.trim();
  const treeProps = {
    pages: pages ?? [],
    activePageId,
    query,
    onQueryChange: setQuery,
    searchHits,
    searching,
    onNewPage: () => void createPage(),
    onLearnRepo: () => {
      setLearnOpen(true);
      setMobileTreeOpen(false);
    },
  };

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 overflow-hidden pt-14">
        {desktop && (
          <aside aria-label="Wiki pages" className="flex h-full w-60 shrink-0 flex-col border-r border-white/[0.06]">
            <WikiTree {...treeProps} onSelect={handleSelect} />
          </aside>
        )}

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {!desktop && (
            <div className="flex shrink-0 items-center border-b border-white/[0.06] px-2 py-1.5">
              <Button size="sm" variant="ghost" onClick={() => setMobileTreeOpen(true)}>
                <PanelLeft /> Pages
              </Button>
            </div>
          )}

          {pagesError ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-sm text-zinc-500">
              {pagesError}
              <button type="button" onClick={() => loadPages(agent.id)} className="font-medium text-zinc-200 hover:underline">
                Try again
              </button>
            </div>
          ) : pages === null || (activePageId !== null && page === null && !pageError) ? (
            <div className="flex flex-1 items-center justify-center text-sm text-zinc-500">Loading…</div>
          ) : isEmptyWorkspace ? (
            <WikiEmptyState agentName={agent.name} mascot={agent.mascot} onLearnRepo={() => setLearnOpen(true)} />
          ) : page ? (
            <WikiPageView
              page={page}
              editing={editing}
              onEditingChange={setEditing}
              onChanged={handlePageChanged}
              onDeleted={handlePageDeleted}
              contentRef={contentRef}
            />
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-sm text-zinc-500">
              {pageError}
              {activePageId && (
                <button
                  type="button"
                  onClick={() => refetchActivePage(activePageId)}
                  className="font-medium text-zinc-200 hover:underline"
                >
                  Try again
                </button>
              )}
            </div>
          )}
        </div>

        {xlWide && page && !editing && !isEmptyWorkspace && headings.length > 0 && (
          <WikiOutline headings={headings} onSelect={scrollToHeading} />
        )}
      </div>

      {!desktop && (
        <Modal
          open={mobileTreeOpen}
          onOpenChange={setMobileTreeOpen}
          title="Pages"
          className="flex h-[min(80dvh,560px)] max-w-sm flex-col"
        >
          <WikiTree {...treeProps} onSelect={handleSelect} />
        </Modal>
      )}

      <LearnRepoDialog agent={agent} open={learnOpen} onOpenChange={setLearnOpen} />
    </div>
  );
}
