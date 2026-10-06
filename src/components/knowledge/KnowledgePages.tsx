import { useMemo, useState } from "react";
import clsx from "clsx";
import { ChevronRight, FolderGit2 } from "lucide-react";
import type { WikiPageSummary } from "@shared/types";
import { buildWikiTree, type WikiTreeNode } from "../../lib/wiki";
import { EmptyState } from "../ui/EmptyState";
import { listRowClass } from "../ui/ListRow";

/**
 * The Knowledge panel's Pages and Repos tabs (roadmap module 11): the project brain's wiki as a collapsible tree,
 * and each repo's docs (the page that heads them, then everything under it). A page opens in the wiki's page view.
 */

type OpenPage = (pageId: string) => void;

/** Shows and hides nested rows; `initial` starts some folded. */
function useCollapsed(initial: () => Set<string> = () => new Set()) {
  const [collapsed, setCollapsed] = useState(initial);
  const toggle = (id: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return { collapsed, toggle };
}

export function KnowledgePages({ pages, onOpen, onOpenWiki }: { pages: WikiPageSummary[]; onOpen: OpenPage; onOpenWiki?: () => void }) {
  const tree = useMemo(() => buildWikiTree(pages), [pages]);
  // A repo's docs start folded here: the Repos tab shows them open.
  const { collapsed, toggle } = useCollapsed(() => new Set(pages.filter((page) => page.repo).map((page) => page.id)));

  return (
    <div className="space-y-3">
      <ul aria-label="Pages">
        {tree.map((node) => (
          <PageNode key={node.id} node={node} depth={0} collapsed={collapsed} onToggle={toggle} onOpen={onOpen} />
        ))}
      </ul>
      {pages.length <= 1 && (
        <p className="px-2.5 text-xs leading-relaxed text-fg-subtle">
          Agents add pages here as they learn about the project: how it's built, decisions, how-tos.
        </p>
      )}
      {onOpenWiki && (
        <button type="button" onClick={onOpenWiki} className="link-muted px-2.5 text-xs">
          Search and edit in the wiki
        </button>
      )}
    </div>
  );
}

function index(nodes: WikiTreeNode[], into = new Map<string, WikiTreeNode>()) {
  for (const node of nodes) {
    into.set(node.id, node);
    index(node.children, into);
  }
  return into;
}

const countPages = (node: WikiTreeNode): number => node.children.reduce((sum, child) => sum + countPages(child), 1);

export function KnowledgeRepos({ pages, onOpen }: { pages: WikiPageSummary[]; onOpen: OpenPage }) {
  const heads = useMemo(() => {
    const nodes = index(buildWikiTree(pages));
    return pages.flatMap((page) => (page.repo && nodes.get(page.id) ? [nodes.get(page.id)!] : []));
  }, [pages]);
  const { collapsed, toggle } = useCollapsed();

  if (!heads.length) {
    return (
      <EmptyState
        size="sm"
        icon={<FolderGit2 />}
        title="No repo docs yet"
        description="Learn a repo to write them up: how it's built and where things are."
      />
    );
  }

  return (
    <div className="space-y-3">
      {heads.map((head) => {
        const name = head.repo ?? head.title;
        const count = countPages(head);
        return (
          <section key={head.id} aria-label={`The ${name} repo's docs`}>
            <button type="button" onClick={() => onOpen(head.id)} className={listRowClass({ size: "sm" })} title={head.summary || undefined}>
              <FolderGit2 className="size-4 shrink-0 text-fg-muted" aria-hidden="true" />
              <span className="min-w-0 truncate font-medium">{name}</span>
              {head.title.trim().toLowerCase() !== name.trim().toLowerCase() && (
                <span className="min-w-0 truncate text-fg-subtle">{head.title}</span>
              )}
              <span className="ml-auto shrink-0 pl-2 text-xs text-fg-subtle tabular-nums">
                {count} {count === 1 ? "page" : "pages"}
              </span>
            </button>
            {head.children.length > 0 && (
              <ul>
                {head.children.map((child) => (
                  <PageNode key={child.id} node={child} depth={1} collapsed={collapsed} onToggle={toggle} onOpen={onOpen} />
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

function PageNode({
  node,
  depth,
  collapsed,
  onToggle,
  onOpen,
}: {
  node: WikiTreeNode;
  depth: number;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  onOpen: OpenPage;
}) {
  const hasChildren = node.children.length > 0;
  const folded = collapsed.has(node.id);
  const title = node.title || "Untitled";

  return (
    <li>
      <div className={listRowClass({ size: "sm" })} style={{ paddingLeft: 4 + depth * 14 }}>
        {hasChildren ? (
          <button
            type="button"
            onClick={() => onToggle(node.id)}
            aria-expanded={!folded}
            aria-label={folded ? `Expand ${title}` : `Collapse ${title}`}
            className="grid size-5 shrink-0 place-items-center rounded text-fg-subtle transition-colors hover:text-fg"
          >
            <ChevronRight className={clsx("size-3.5 transition-transform", !folded && "rotate-90")} />
          </button>
        ) : (
          <span className="size-5 shrink-0" aria-hidden="true" />
        )}
        <button type="button" onClick={() => onOpen(node.id)} className="flex min-w-0 flex-1 items-center gap-1.5 text-left" title={node.summary || undefined}>
          <span className="truncate">{title}</span>
          {node.repo && (
            <span className="flex shrink-0 text-fg-subtle" title={`The ${node.repo} repo's docs`}>
              <FolderGit2 className="size-3.5" aria-hidden="true" />
              <span className="sr-only">(the {node.repo} repo's docs)</span>
            </span>
          )}
        </button>
      </div>
      {hasChildren && !folded && (
        <ul>
          {node.children.map((child) => (
            <PageNode key={child.id} node={child} depth={depth + 1} collapsed={collapsed} onToggle={onToggle} onOpen={onOpen} />
          ))}
        </ul>
      )}
    </li>
  );
}
