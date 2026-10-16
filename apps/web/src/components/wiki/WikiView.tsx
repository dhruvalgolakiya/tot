import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Laptop, PanelLeft } from "lucide-react";
import type { KnowledgeStatus, WikiPage, WikiPageSummary, WikiSearchHit } from "@tot/shared/types";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { DESKTOP_QUERY, useMediaQuery, XL_QUERY } from "../../hooks/useMediaQuery";
import { api, errorMessage } from "../../lib/api";
import { extractHeadings } from "../../lib/wiki";
import { brainName } from "../../lib/brains";
import { projectMemoryRepo, useMemoryUi } from "../../lib/memory";
import { useProjects } from "../../lib/projects";
import { navigateToWiki, openBrain, openWikiPage, selectActiveAgent, useStore } from "../../store";
import { Button } from "../ui/Button";
import { Callout } from "../ui/Callout";
import { EmptyState } from "../ui/EmptyState";
import { Modal } from "../ui/Modal";
import { Skeleton } from "../ui/Skeleton";
import { KnowledgeFacts } from "../knowledge/KnowledgeFacts";
import { KnowledgeHistoryView } from "../knowledge/KnowledgeHistoryView";
import { RepoProfileDialog } from "../trust/RepoProfileDialog";
import { BrainSettingsDialog } from "./BrainSettingsDialog";
import { BrainSwitcher } from "./BrainSwitcher";
import { LearnRepoDialog } from "./LearnRepoDialog";
import { NewBrainDialog } from "./NewBrainDialog";
import { WikiEmptyState } from "./WikiEmptyState";
import { WikiOutline } from "./WikiOutline";
import { WikiPageView } from "./WikiPageView";
import { WikiTree } from "./WikiTree";

/** Facts and History are views of a project's knowledge; null shows a page. */
type Section = "facts" | "history" | null;

/**
 * The Knowledge page, the one place for what agents know: a switcher (this agent's notebook, a project, a shared
 * brain) and the open one's Facts, page tree, repo docs and History on the left, the open page or view in the
 * middle, an optional "On this page" outline on very wide screens. Mounted in the main card in place of ChatView
 * while `page === "wiki"` (see App.tsx and store.ts). The brain shown is the one picked, else the open page's, else
 * the agent's notebook; a project's opens on its Facts.
 */
export function WikiView() {
  const agent = useStore(selectActiveAgent);
  const agentId = agent?.id ?? null;
  // An agent on a paired device (module 07) has its brains there, shared only with that device's agents.
  const deviceId = agent?.deviceId;
  const allAgents = useStore((s) => s.agents);
  const agents = useMemo(() => allAgents.filter((a) => a.deviceId === deviceId), [allAgents, deviceId]);
  const brains = useStore((s) => (deviceId ? (s.deviceBrains[deviceId] ?? null) : s.brains));
  const wikiPageId = useStore((s) => s.wikiPageId);
  const wikiBrainId = useStore((s) => s.wikiBrainId);
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
  const [newBrainOpen, setNewBrainOpen] = useState(false);
  const [brainSettingsOpen, setBrainSettingsOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  // The view picked in the column while no page is open; a page opening clears it.
  const [picked, setPicked] = useState<{ brainId: string | null; section: Section }>({ brainId: null, section: null });
  const [status, setStatus] = useState<KnowledgeStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [query, setQuery] = useState("");
  const search = useDebouncedValue(query.trim(), 250);
  const [searchHits, setSearchHits] = useState<WikiSearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);

  const contentRef = useRef<HTMLDivElement>(null);

  const notebookId = brains?.find((b) => b.ownerAgentId === agentId)?.id ?? null;
  // A page opened by id (from a chat notice, say) shows its own brain; until it loads, nothing is listed.
  const brainId = wikiBrainId ?? (wikiPageId ? (page?.id === wikiPageId ? page.brainId : null) : notebookId);
  const brain = brains?.find((b) => b.id === brainId) ?? null;
  const allProjects = useProjects((st) => st.projects);
  const projectBrainIds = useMemo(() => new Set(allProjects.map((p) => p.brainId)), [allProjects]);
  const project = brainId ? (allProjects.find((p) => p.brainId === brainId) ?? null) : null;
  // A paired device's project keeps its knowledge there; its facts and history can't be read from here.
  const localProject = project && !project.deviceId ? project : null;
  const remoteProject = Boolean(project?.deviceId && brains && !brain);
  const memoryVersion = useMemoryUi((st) => (localProject ? (st.versions[projectMemoryRepo(localProject.slug)] ?? 0) : 0));
  const section: Section = wikiPageId
    ? null
    : picked.brainId === brainId && picked.section
      ? picked.section
      : localProject
        ? "facts"
        : null;
  const activePageId = wikiPageId ?? (section ? null : (pages?.[0]?.id ?? null));
  const pageIds = useMemo(() => (pages ? new Set(pages.map((p) => p.id)) : null), [pages]);

  function loadPages(id: string) {
    api.listWikiPages(id).then(
      (list) => {
        setPages(list);
        setPagesError(null);
      },
      (error: unknown) => setPagesError(errorMessage(error)),
    );
  }

  const loadStatus = useCallback(() => {
    if (!localProject) return;
    api.knowledgeStatus(localProject.id).then(
      (loaded) => {
        setStatus(loaded);
        setStatusError(null);
      },
      (error: unknown) => setStatusError(errorMessage(error)),
    );
  }, [localProject]);

  // A project's counts and folder: its facts and pages both commit to its repo, so either change can move them.
  useEffect(() => {
    setStatus(null);
    setStatusError(null);
  }, [localProject?.id]);
  useEffect(() => {
    loadStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload on the project, a memory change or a wiki event
  }, [localProject?.id, memoryVersion, wikiEvent]);

  function refetchActivePage(id: string) {
    api.getWikiPage(id).then(setPage, (error: unknown) => setPageError(errorMessage(error)));
  }

  // Load the brain's pages fresh whenever another brain is shown.
  useEffect(() => {
    setPages(null);
    setPagesError(null);
    setQuery("");
    if (!brainId) return;
    loadPages(brainId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload keyed only on the brain
  }, [brainId]);

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

  // A tool call or the background keeper changed this brain: refresh the tree,
  // and the open page too — unless it's being edited right now.
  useEffect(() => {
    if (!brainId || !wikiEvent || wikiEvent.brainId !== brainId) return;
    loadPages(brainId);
    if (activePageId && !editing) refetchActivePage(activePageId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-run when a new event comes in
  }, [wikiEvent]);

  // Search the brain instead of showing the tree once there's a query.
  useEffect(() => {
    if (!brainId || !search) {
      setSearchHits(null);
      setSearching(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    api.searchWiki(brainId, search).then(
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
  }, [brainId, search]);

  const headings = useMemo(() => (page ? extractHeadings(page.content) : []), [page]);

  if (!agent) {
    return (
      <div className="flex min-h-0 flex-1 overflow-hidden pt-14" aria-busy="true" aria-label="Loading knowledge">
        {desktop && (
          <div className="flex h-full w-60 shrink-0 flex-col gap-2 border-r border-hairline p-3">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-5/6" />
            <Skeleton className="h-8 w-4/6" />
          </div>
        )}
        <div className="mx-auto w-full max-w-3xl space-y-3 px-4 py-8 sm:px-8">
          <Skeleton className="h-9 w-2/3" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-5/6" />
          <Skeleton className="h-4 w-4/6" />
        </div>
      </div>
    );
  }

  function handleSelect(pageId: string) {
    openWikiPage(pageId, brainId);
    setPicked({ brainId, section: null });
    setMobileTreeOpen(false);
  }

  function openSection(next: Section) {
    openWikiPage(null, brainId);
    setPicked({ brainId, section: next });
    setEditing(false);
    setMobileTreeOpen(false);
  }

  async function createPage() {
    try {
      if (!brainId) return;
      const created = await api.createWikiPage(brainId, { title: "Untitled", content: "" });
      setPages((list) => (list ? [...list, created] : [created]));
      setPage(created);
      setEditing(true);
      openWikiPage(created.id, brainId);
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
    if (brainId) loadPages(brainId);
    openWikiPage(null);
  }

  function handleOpenBrain(id: string) {
    openBrain(id);
    setMobileTreeOpen(false);
  }

  function scrollToHeading(text: string) {
    const root = contentRef.current;
    if (!root) return;
    const target = Array.from(root.querySelectorAll<HTMLElement>("h2, h3")).find((el) => el.textContent?.trim() === text);
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const isEmptyWorkspace =
    brain?.kind === "notebook" && pages !== null && pages.length === 1 && page !== null && !page.content.trim();
  const switcher = (
    <BrainSwitcher
      agent={agent}
      agents={agents}
      brains={brains}
      current={brain}
      onOpen={handleOpenBrain}
      onNew={() => {
        setNewBrainOpen(true);
        setMobileTreeOpen(false);
      }}
      onSettings={() => {
        setBrainSettingsOpen(true);
        setMobileTreeOpen(false);
      }}
      onProfile={() => {
        setProfileOpen(true);
        setMobileTreeOpen(false);
      }}
      projectBrainIds={projectBrainIds}
      placeholder={remoteProject ? project?.name : undefined}
    />
  );
  const treeProps = {
    pages: pages ?? [],
    activePageId,
    query,
    onQueryChange: setQuery,
    searchHits,
    searching,
    searchLabel: brain ? `Search ${brainName(brain, agents, agent.id)}` : "Search",
    onNewPage: () => void createPage(),
    onLearnRepo: () => {
      setLearnOpen(true);
      setMobileTreeOpen(false);
    },
    facts: localProject
      ? { count: status?.facts ?? null, active: section === "facts", onOpen: () => openSection("facts") }
      : undefined,
    history: localProject ? { active: section === "history", onOpen: () => openSection("history") } : undefined,
  };
  const mobileLabel = section === "facts" ? "Facts" : section === "history" ? "History" : (page?.title ?? "Pages");

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-0 flex-1 overflow-hidden pt-14">
        {desktop && (
          <aside aria-label="Knowledge" className="flex h-full w-64 shrink-0 flex-col border-r border-hairline">
            {switcher}
            <WikiTree {...treeProps} onSelect={handleSelect} />
          </aside>
        )}

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {!desktop && (
            <div className="flex shrink-0 items-center border-b border-hairline px-2 py-1.5">
              <Button size="sm" variant="ghost" onClick={() => setMobileTreeOpen(true)}>
                <PanelLeft /> <span className="max-w-60 truncate">{mobileLabel}</span>
              </Button>
            </div>
          )}

          {remoteProject ? (
            <div className="flex flex-1 items-center justify-center p-6">
              <EmptyState
                icon={<Laptop />}
                title="Knowledge stays on its device"
                description="This project's pages and facts are kept on the Mac it's on. Open TOT there to see them."
              />
            </div>
          ) : section === "facts" && localProject ? (
            <KnowledgeFacts
              project={localProject}
              status={status}
              statusError={statusError}
              onRetry={loadStatus}
              onChanged={loadStatus}
            />
          ) : section === "history" && localProject ? (
            <KnowledgeHistoryView
              project={localProject}
              pageIds={pageIds}
              onOpenPage={handleSelect}
              onChanged={() => {
                loadStatus();
                if (brainId) loadPages(brainId);
              }}
            />
          ) : pagesError ? (
            <div className="flex flex-1 items-center justify-center p-6">
              <Callout
                tone="danger"
                action={
                  <button type="button" onClick={() => brainId && loadPages(brainId)} className="link-muted">
                    Try again
                  </button>
                }
              >
                {pagesError}
              </Callout>
            </div>
          ) : (pages === null && !pageError) || (activePageId !== null && page === null && !pageError) ? (
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div
                className="mx-auto w-full max-w-3xl space-y-3 px-4 py-8 sm:px-8"
                aria-busy="true"
                aria-label="Loading page"
              >
                <Skeleton className="h-9 w-2/3" />
                <Skeleton className="h-4 w-11/12" />
                <Skeleton className="h-4 w-5/6" />
                <Skeleton className="h-4 w-4/6" />
              </div>
            </div>
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
            <div className="flex flex-1 items-center justify-center p-6">
              <Callout
                tone="danger"
                action={
                  activePageId ? (
                    <button type="button" onClick={() => refetchActivePage(activePageId)} className="link-muted">
                      Try again
                    </button>
                  ) : undefined
                }
              >
                {pageError}
              </Callout>
            </div>
          )}
        </div>

        {xlWide && !section && page && !editing && !isEmptyWorkspace && headings.length > 0 && (
          <WikiOutline headings={headings} onSelect={scrollToHeading} />
        )}
      </div>

      {!desktop && (
        <Modal
          open={mobileTreeOpen}
          onOpenChange={setMobileTreeOpen}
          title="Knowledge"
          className="flex h-[min(80dvh,560px)] max-w-sm flex-col"
        >
          {switcher}
          <WikiTree {...treeProps} onSelect={handleSelect} />
        </Modal>
      )}

      <LearnRepoDialog agent={agent} open={learnOpen} onOpenChange={setLearnOpen} />
      <NewBrainDialog
        agent={agent}
        open={newBrainOpen}
        onOpenChange={setNewBrainOpen}
        onCreated={(created) => openBrain(created.id)}
        onLearnRepo={() => setLearnOpen(true)}
      />
      {brain && (
        <BrainSettingsDialog
          brain={brain}
          agents={agents}
          viewerAgentId={agent.id}
          open={brainSettingsOpen}
          onOpenChange={setBrainSettingsOpen}
          onDeleted={() => navigateToWiki(agent.id)}
        />
      )}
      {brain?.kind === "repo" && <RepoProfileDialog brain={brain} agent={agent} open={profileOpen} onOpenChange={setProfileOpen} />}
    </div>
  );
}
