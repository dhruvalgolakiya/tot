import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Tabs } from "radix-ui";
import { Laptop, LoaderCircle } from "lucide-react";
import type { KnowledgeStatus, Project, WikiPageSummary } from "@shared/types";
import { api, errorMessage } from "../../lib/api";
import { projectMemoryRepo, useMemoryUi } from "../../lib/memory";
import { navigateToWiki, selectActiveAgent, useStore } from "../../store";
import { MemoryEntries } from "../memory/MemoryEntries";
import { Callout } from "../ui/Callout";
import { EmptyState } from "../ui/EmptyState";
import { Skeleton } from "../ui/Skeleton";
import { KnowledgeHistory } from "./KnowledgeHistory";
import { KnowledgePages, KnowledgeRepos } from "./KnowledgePages";

type KnowledgeTab = "facts" | "pages" | "repos" | "history";

const TABS: { id: KnowledgeTab; label: string }[] = [
  { id: "facts", label: "Facts" },
  { id: "pages", label: "Pages" },
  { id: "repos", label: "Repos" },
  { id: "history", label: "History" },
];

/** Pill tabs (neutral, DESIGN.md). */
const tabTrigger =
  "flex h-8 shrink-0 items-center rounded-full px-3 text-ui font-medium text-fg-muted transition-colors " +
  "hover:bg-hover hover:text-fg data-[state=active]:bg-selected data-[state=active]:text-fg";

/** The tab picked last, so coming back to a project (after opening one of its pages) shows the same one. */
let lastTab: KnowledgeTab = "facts";

/**
 * Module 11 (docs/roadmap/11-workspaces.md), lane B: a project's knowledge, its wiki pages and memory facts in one
 * git repo. One quiet line says where it lives; tabs show the Facts (module 10's entries), the Pages (the project
 * brain's wiki tree), each repo's docs, and one History of both with Undo. Pages open in the wiki's page view.
 */
export function KnowledgePanel({ project }: { project: Project }) {
  if (project.deviceId) {
    return (
      <EmptyState
        size="sm"
        icon={<Laptop />}
        title="Knowledge stays on its device"
        description="This project's pages and facts are kept on the Mac it's on. Open TOT there to see them."
      />
    );
  }
  return <ProjectKnowledge key={project.id} project={project} />;
}

/** Bumps when the app hears that this brain's wiki changed (the `wikiEvent` ping), ignoring other brains. */
function useWikiVersion(brainId: string): number {
  const [version, setVersion] = useState(0);
  useEffect(
    () =>
      useStore.subscribe((state, previous) => {
        if (state.wikiEvent !== previous.wikiEvent && state.wikiEvent?.brainId === brainId) setVersion((n) => n + 1);
      }),
    [brainId],
  );
  return version;
}

function ProjectKnowledge({ project }: { project: Project }) {
  const repo = projectMemoryRepo(project.slug);
  const memoryVersion = useMemoryUi((s) => s.versions[repo] ?? 0);
  const wikiVersion = useWikiVersion(project.brainId);
  const agent = useStore(selectActiveAgent);
  const [tab, setTab] = useState<KnowledgeTab>(lastTab);
  const [status, setStatus] = useState<KnowledgeStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [pages, setPages] = useState<WikiPageSummary[] | null>(null);
  const [pagesError, setPagesError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      setStatus(await api.knowledgeStatus(project.id));
      setStatusError(null);
    } catch (error) {
      setStatusError(errorMessage(error));
    }
  }, [project.id]);

  const loadPages = useCallback(async () => {
    try {
      setPages(await api.listWikiPages(project.brainId));
      setPagesError(null);
    } catch (error) {
      setPagesError(errorMessage(error));
    }
  }, [project.brainId]);

  // Facts and pages both commit to the project's repo, so either kind of change can move the counts.
  useEffect(() => {
    void loadStatus();
  }, [loadStatus, memoryVersion, wikiVersion]);

  useEffect(() => {
    void loadPages();
  }, [loadPages, wikiVersion]);

  const pageIds = useMemo(() => (pages ? new Set(pages.map((page) => page.id)) : null), [pages]);

  const reload = () => {
    void loadStatus();
    void loadPages();
  };

  const openPage = (pageId: string) => {
    if (agent) navigateToWiki(agent.id, pageId);
  };

  const pagesState = (render: (list: WikiPageSummary[]) => ReactNode) => {
    if (pages) return render(pages);
    if (pagesError) {
      return (
        <Callout tone="danger" action={<RetryButton onClick={() => void loadPages()} />}>
          Couldn't load the pages. {pagesError}
        </Callout>
      );
    }
    return (
      <div className="space-y-1.5 px-1" aria-busy="true" aria-label="Loading pages">
        <Skeleton className="h-4 w-2/5" />
        <Skeleton className="h-4 w-3/5" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    );
  };

  return (
    <section aria-label="Knowledge" className="space-y-3">
      <StatusLine status={status} error={statusError} onRetry={() => void loadStatus()} />
      <Tabs.Root
        value={tab}
        onValueChange={(value) => {
          lastTab = value as KnowledgeTab;
          setTab(lastTab);
        }}
      >
        {/* The negative margin gives focus rings room inside the scroller (narrow phones scroll the pills sideways). */}
        <Tabs.List aria-label="Knowledge sections" className="-m-1 flex gap-0.5 overflow-x-auto p-1">
          {TABS.map((t) => (
            <Tabs.Trigger key={t.id} value={t.id} className={tabTrigger}>
              {t.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        <Tabs.Content value="facts" className="mt-4">
          <MemoryEntries repo={repo} kind="project" onChanged={() => void loadStatus()} />
        </Tabs.Content>
        <Tabs.Content value="pages" className="mt-3">
          {pagesState((list) => (
            <KnowledgePages pages={list} onOpen={openPage} onOpenWiki={agent ? () => navigateToWiki(agent.id, null, project.brainId) : undefined} />
          ))}
        </Tabs.Content>
        <Tabs.Content value="repos" className="mt-3">
          {pagesState((list) => (
            <KnowledgeRepos pages={list} onOpen={openPage} />
          ))}
        </Tabs.Content>
        <Tabs.Content value="history" className="mt-4">
          <KnowledgeHistory project={project} pageIds={pageIds} onOpenPage={openPage} onChanged={reload} />
        </Tabs.Content>
      </Tabs.Root>
    </section>
  );
}

function RetryButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="link-muted">
      Retry
    </button>
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** One quiet line of chrome: the repo's folder and counts; while the wiki moves into git, or after that failed, a note instead. */
function StatusLine({ status, error, onRetry }: { status: KnowledgeStatus | null; error: string | null; onRetry: () => void }) {
  if (!status) {
    if (error) {
      return (
        <Callout tone="danger" action={<RetryButton onClick={onRetry} />}>
          Couldn't load this project's knowledge. {error}
        </Callout>
      );
    }
    return (
      <div className="flex h-5 items-center" aria-busy="true" aria-label="Loading knowledge">
        <Skeleton className="h-3.5 w-3/5" />
      </div>
    );
  }
  if (status.state === "database" && status.error) {
    return (
      <Callout tone="warning">
        The wiki couldn't move into git yet; it works as before and TOT tries again at the next start.
        <span className="mt-1 block font-mono text-xs opacity-80">{status.error}</span>
      </Callout>
    );
  }
  if (status.state === "moving") {
    return (
      <p className="flex h-5 items-center gap-1.5 text-xs text-fg-subtle">
        <LoaderCircle className="size-3.5 shrink-0 animate-spin" aria-hidden="true" />
        Moving the wiki into git…
      </p>
    );
  }
  return (
    <p className="flex h-5 min-w-0 items-center gap-1.5 text-xs text-fg-subtle tabular-nums" title="This project's pages and facts, in one git repo on this Mac">
      <span className="min-w-0 truncate font-mono text-ui text-fg-muted">{status.path}</span>
      <span className="shrink-0">
        · {plural(status.pages, "page", "pages")} · {plural(status.facts, "fact", "facts")}
      </span>
    </p>
  );
}
