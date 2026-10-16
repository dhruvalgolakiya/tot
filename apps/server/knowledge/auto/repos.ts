import { basename } from "node:path";
import type { Project, ProjectRepo, TaskRepo, WikiPageSummary } from "@tot/shared/types";
import { wiki } from "../../data/wiki.ts";
import { projectRepoId } from "../../memory/repo.ts";

/**
 * Module 11, lane C: a project's repos and knowledge as auto-update sees them. Lane A gives a project several
 * repos (`Project.repos`, the primary first) and each task the one it works in (`TaskRepo.repoName`); before
 * that, a project's one repo is its own `kind`/`source`. This works either way. The knowledge is the project's
 * brain (its wiki, through `wiki.*`) and its memory repo (`projects/<slug>`, module 10), which lane B makes one
 * git repo; a repo's docs are the page marked with its name (`WikiPageSummary.repo`) and that page's subtree.
 */

/** "acme/web", "https://github.com/acme/web.git", "/Users/me/code/web" → "web". */
export function repoNameFor(source: string): string {
  return basename(source.trim().replace(/\/+$/, "").replace(/\.git$/i, "")) || "repo";
}

/** The project's repos, the primary first: lane A's list, or the one its own source names. */
export function projectRepos(project: Project): ProjectRepo[] {
  if (project.repos) return project.repos;
  if (project.kind === "none" || !project.source) return [];
  return [
    {
      name: repoNameFor(project.source),
      kind: project.kind,
      source: project.source,
      defaultBranch: project.defaultBranch,
      folderGranted: project.kind === "github" || project.folderGranted,
      primary: true,
    },
  ];
}

/** The repo a task worked in: the one it names, else the project's primary. */
export function repoOfTask(project: Project, repo: TaskRepo | null): ProjectRepo | null {
  const repos = projectRepos(project);
  return (repo?.repoName ? repos.find((r) => r.name === repo.repoName) : null) ?? repos.find((r) => r.primary) ?? repos[0] ?? null;
}

/** The project's knowledge repo (module 10's id): where its facts live, and with lane B its pages too. */
export const knowledgeRepo = (project: Project) => projectRepoId(project.slug);

export type OutlinePage = WikiPageSummary & { depth: number };

/**
 * A repo's doc pages: the page heading its docs (`repo: <name>`) and everything under it; without one (before
 * lane B, or a repo not learned yet), the whole project wiki. `home` is where new pages go by default (the head
 * page), and the page shown in full first (the head page, else the project's Overview).
 */
export function docScope(project: Project, repoName: string | null): { pages: OutlinePage[]; head: OutlinePage | null; home: OutlinePage | null } {
  const outline = wiki.outline(project.brainId);
  const at = repoName ? outline.findIndex((page) => page.repo === repoName) : -1;
  if (at < 0) return { pages: outline, head: null, home: outline.find((page) => page.pinned) ?? null };
  const head = outline[at]!;
  const pages = [head];
  // Tree order: the head's subtree is everything after it that sits deeper.
  for (const page of outline.slice(at + 1)) {
    if (page.depth <= head.depth) break;
    pages.push(page);
  }
  return { pages, head, home: head };
}
