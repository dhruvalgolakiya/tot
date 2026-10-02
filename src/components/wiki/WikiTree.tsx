import { useState } from "react";
import clsx from "clsx";
import { DropdownMenu } from "radix-ui";
import { ChevronRight, FilePlus, GitBranch, Plus, Search } from "lucide-react";
import type { WikiPageSummary, WikiSearchHit } from "@shared/types";
import { buildWikiTree, splitSnippet, type WikiTreeNode } from "../../lib/wiki";
import { IconButton } from "../ui/IconButton";

type WikiTreeProps = {
  pages: WikiPageSummary[];
  activePageId: string | null;
  onSelect: (pageId: string) => void;
  query: string;
  onQueryChange: (value: string) => void;
  searchHits: WikiSearchHit[] | null;
  searching: boolean;
  onNewPage: () => void;
  onLearnRepo: () => void;
};

/** Left column: search, a page tree (collapsible, Overview first), and one "+" menu for new pages. */
export function WikiTree({
  pages,
  activePageId,
  onSelect,
  query,
  onQueryChange,
  searchHits,
  searching,
  onNewPage,
  onLearnRepo,
}: WikiTreeProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const tree = buildWikiTree(pages);
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
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-zinc-500" />
          <input
            type="text"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="Search wiki"
            aria-label="Search wiki"
            className="input h-8 pl-8 text-[13px]"
          />
        </div>
      </div>

      {!isSearching && (
        <div className="flex shrink-0 items-center px-2.5 pb-1">
          <span className="label-caps">Pages</span>
          <DropdownMenu.Root modal={false}>
            <DropdownMenu.Trigger asChild>
              <IconButton label="Add a page" size="sm" className="ml-auto">
                <Plus />
              </IconButton>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content align="end" sideOffset={4} className="menu w-48">
                <DropdownMenu.Item className="menu-item" onSelect={onNewPage}>
                  <FilePlus className="size-4 text-zinc-400" /> New page
                </DropdownMenu.Item>
                <DropdownMenu.Item className="menu-item" onSelect={onLearnRepo}>
                  <GitBranch className="size-4 text-zinc-400" /> Learn a repo…
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
        {isSearching ? (
          <SearchResults hits={searchHits} searching={searching} onSelect={onSelect} />
        ) : (
          <ul>
            {tree.map((node) => (
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
        )}
      </div>
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
      <div className="space-y-1.5 px-1 py-1" aria-label="Searching">
        {[0, 1, 2].map((key) => (
          <div key={key} className="h-12 animate-pulse rounded-lg bg-white/[0.03]" />
        ))}
      </div>
    );
  }
  if (hits && hits.length === 0) {
    return <p className="px-2.5 py-4 text-center text-xs text-zinc-500">No pages match.</p>;
  }
  return (
    <ul className="space-y-0.5">
      {(hits ?? []).map((hit) => (
        <li key={hit.id}>
          <button
            type="button"
            onClick={() => onSelect(hit.id)}
            className="block w-full rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-white/[0.04]"
          >
            <div className="truncate text-[13px] font-medium text-zinc-100">{hit.title}</div>
            <div className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-zinc-500">
              {splitSnippet(hit.snippet).map((part, index) =>
                part.marked ? (
                  <mark key={index} className="rounded-sm bg-[var(--agent-accent-16)] px-0.5 text-[var(--agent-accent-text)]">
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
}: {
  node: WikiTreeNode;
  depth: number;
  activePageId: string | null;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
}) {
  const hasChildren = node.children.length > 0;
  const isCollapsed = collapsed.has(node.id);
  const active = node.id === activePageId;

  return (
    <li>
      <div
        className={clsx(
          "flex h-8 items-center gap-0.5 rounded-lg pr-2 text-[13px] transition-colors",
          active ? "bg-white/[0.08] text-zinc-50" : "text-zinc-300 hover:bg-white/[0.04] hover:text-zinc-100",
        )}
        style={{ paddingLeft: 4 + depth * 14 }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => onToggle(node.id)}
            aria-label={isCollapsed ? `Expand ${node.title}` : `Collapse ${node.title}`}
            className="grid size-5 shrink-0 place-items-center rounded text-zinc-500 transition-colors hover:text-zinc-200"
          >
            <ChevronRight className={clsx("size-3.5 transition-transform", !isCollapsed && "rotate-90")} />
          </button>
        ) : (
          <span className="size-5 shrink-0" aria-hidden="true" />
        )}
        <button type="button" onClick={() => onSelect(node.id)} className="min-w-0 flex-1 truncate text-left">
          {node.title || "Untitled"}
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
