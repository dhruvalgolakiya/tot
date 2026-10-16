import { useState, type ReactNode } from "react";
import clsx from "clsx";
import { DropdownMenu } from "radix-ui";
import { ChevronRight, FilePlus, FolderGit2, GitBranch, History, ListChecks, Plus } from "lucide-react";
import type { WikiPageSummary, WikiSearchHit } from "@shared/types";
import { buildWikiTree, splitSnippet, type WikiTreeNode } from "../../lib/wiki";
import { EmptyState } from "../ui/EmptyState";
import { IconButton } from "../ui/IconButton";
import { ListRow, listRowClass } from "../ui/ListRow";
import { SearchInput } from "../ui/SearchInput";
import { Skeleton } from "../ui/Skeleton";

type WikiTreeProps = {
  pages: WikiPageSummary[];
  activePageId: string | null;
  onSelect: (pageId: string) => void;
  query: string;
  onQueryChange: (value: string) => void;
  searchHits: WikiSearchHit[] | null;
  searching: boolean;
  /** Placeholder and label of the search box, e.g. "Search Notebook". */
  searchLabel: string;
  onNewPage: () => void;
  onLearnRepo: () => void;
  /** A project's facts: pinned first, opening the Facts view. */
  facts?: { count: number | null; active: boolean; onOpen: () => void };
  /** A project's history: at the bottom of the column, opening the History view. */
  history?: { active: boolean; onOpen: () => void };
};

/** Pulls the pages that head a repo's docs (and their subtrees) out of the tree, wherever they sit. */
function splitRepos(nodes: WikiTreeNode[], repos: WikiTreeNode[] = []): { pages: WikiTreeNode[]; repos: WikiTreeNode[] } {
  const pages: WikiTreeNode[] = [];
  for (const node of nodes) {
    if (node.repo) repos.push(node);
    else pages.push({ ...node, children: splitRepos(node.children, repos).pages });
  }
  return { pages, repos };
}

/**
 * Left column of the Knowledge page: search, then Facts (projects), the page tree (collapsible, Overview first)
 * with one "+" menu for new pages, each repo's docs, and History (projects) at the bottom.
 */
export function WikiTree({
  pages,
  activePageId,
  onSelect,
  query,
  onQueryChange,
  searchHits,
  searching,
  searchLabel,
  onNewPage,
  onLearnRepo,
  facts,
  history,
}: WikiTreeProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const tree = splitRepos(buildWikiTree(pages));
  const isSearching = query.trim().length > 0;

  function toggle(id: string) {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 px-2 pt-2 pb-1.5">
        <SearchInput
          compact
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={searchLabel}
          aria-label={searchLabel}
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {isSearching ? (
          <SearchResults hits={searchHits} searching={searching} onSelect={onSelect} />
        ) : (
          <>
            {facts && (
              <ListRow
                size="sm"
                icon={<ListChecks />}
                selected={facts.active}
                aria-current={facts.active ? "page" : undefined}
                onClick={facts.onOpen}
                trailing={facts.count !== null && <span className="tabular-nums">{facts.count}</span>}
                className="mb-2"
              >
                Facts
              </ListRow>
            )}
            <div className="flex items-center px-1 pb-1">
              <span className="group-label">Pages</span>
              <DropdownMenu.Root modal={false}>
                <DropdownMenu.Trigger asChild>
                  <IconButton label="Add a page" size="sm" className="ml-auto">
                    <Plus />
                  </IconButton>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content align="end" sideOffset={4} className="menu w-48">
                    <DropdownMenu.Item className="menu-item" onSelect={onNewPage}>
                      <FilePlus className="size-4 text-fg-muted" /> New page
                    </DropdownMenu.Item>
                    <DropdownMenu.Item className="menu-item" onSelect={onLearnRepo}>
                      <GitBranch className="size-4 text-fg-muted" /> Learn a repo…
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </div>
            <ul aria-label="Pages">
              {tree.pages.map((node) => (
                <TreeNode
                  key={node.id}
                  node={node}
                  depth={0}
                  activePageId={activePageId}
                  collapsed={collapsed}
                  onToggle={toggle}
                  onSelect={onSelect}
                />
              ))}
            </ul>
            {tree.repos.length > 0 && (
              <>
                <div className="flex h-7 items-center px-1 pt-3 pb-1">
                  <span className="group-label">Repos</span>
                </div>
                <ul aria-label="Repos">
                  {tree.repos.map((node) => (
                    <TreeNode
                      key={node.id}
                      node={{ ...node, title: node.repo ?? node.title }}
                      depth={0}
                      activePageId={activePageId}
                      collapsed={collapsed}
                      onToggle={toggle}
                      onSelect={onSelect}
                      icon={<FolderGit2 className="size-3.5" aria-hidden="true" />}
                    />
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </div>

      {history && !isSearching && (
        <div className="shrink-0 border-t border-hairline px-1.5 py-1.5">
          <ListRow
            size="sm"
            icon={<History />}
            selected={history.active}
            aria-current={history.active ? "page" : undefined}
            onClick={history.onOpen}
          >
            History
          </ListRow>
        </div>
      )}
    </div>
  );
}

function SearchResults({
  hits,
  searching,
  onSelect,
}: {
  hits: WikiSearchHit[] | null;
  searching: boolean;
  onSelect: (pageId: string) => void;
}) {
  if (searching && !hits) {
    return (
      <div className="space-y-1.5 px-1 py-1" aria-busy="true" aria-label="Searching">
        {[0, 1, 2].map((key) => (
          <Skeleton key={key} className="h-12" />
        ))}
      </div>
    );
  }
  if (hits && hits.length === 0) {
    return <EmptyState size="sm" title="No pages match." />;
  }
  return (
    <ul className="space-y-0.5">
      {(hits ?? []).map((hit) => (
        <li key={hit.id}>
          <button
            type="button"
            onClick={() => onSelect(hit.id)}
            className="block w-full rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-hover"
          >
            <div className="truncate text-ui font-medium text-fg">{hit.title}</div>
            <div className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-fg-subtle">
              {splitSnippet(hit.snippet).map((part, index) =>
                part.marked ? (
                  <mark key={index} className="rounded-sm bg-accent-soft px-0.5 text-accent-text">
                    {part.text}
                  </mark>
                ) : (
                  <span key={index}>{part.text}</span>
                ),
              )}
            </div>
          </button>
        </li>
      ))}
    </ul>
  );
}

function TreeNode({
  node,
  depth,
  activePageId,
  collapsed,
  onToggle,
  onSelect,
  icon,
}: {
  node: WikiTreeNode;
  depth: number;
  activePageId: string | null;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  /** A repo's docs: a small folder mark before the name. */
  icon?: ReactNode;
}) {
  const hasChildren = node.children.length > 0;
  const isCollapsed = collapsed.has(node.id);
  const active = node.id === activePageId;

  return (
    <li>
      <div className={listRowClass({ selected: active, size: "sm" })} style={{ paddingLeft: 4 + depth * 14 }}>
        {hasChildren ? (
          <button
            type="button"
            onClick={() => onToggle(node.id)}
            aria-label={isCollapsed ? `Expand ${node.title}` : `Collapse ${node.title}`}
            className="grid size-5 shrink-0 place-items-center rounded text-fg-subtle transition-colors hover:text-fg"
          >
            <ChevronRight className={clsx("size-3.5 transition-transform", !isCollapsed && "rotate-90")} />
          </button>
        ) : (
          <span className="size-5 shrink-0" aria-hidden="true" />
        )}
        <button
          type="button"
          onClick={() => onSelect(node.id)}
          aria-current={active ? "page" : undefined}
          title={node.summary || undefined}
          className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        >
          {icon && <span className="shrink-0 text-fg-subtle">{icon}</span>}
          <span className="truncate">{node.title || "Untitled"}</span>
        </button>
      </div>
      {hasChildren && !isCollapsed && (
        <ul>
          {node.children.map((child) => (
            <TreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              activePageId={activePageId}
              collapsed={collapsed}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </ul>
      )}
    </li>
  );
}
