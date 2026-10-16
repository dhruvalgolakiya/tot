import type { AddProjectRepoRequest, Project, ProjectRepo, UpdateProjectRepoRequest } from "@shared/types";
import { api } from "./api";
import { tildePath, upsertProject } from "./projects";

/**
 * A project's repos (roadmap module 11, lane A): any mix of GitHub repos and folders on this Mac, the
 * primary first. The actions throw the server's message (for the dialogs to show inline) and keep the
 * projects store up to date with the project they get back.
 */

export async function addProjectRepo(projectId: string, body: AddProjectRepoRequest): Promise<Project> {
  const project = await api.addProjectRepo(projectId, body);
  upsertProject(project);
  return project;
}

export async function updateProjectRepo(projectId: string, name: string, body: UpdateProjectRepoRequest): Promise<Project> {
  const project = await api.updateProjectRepo(projectId, name, body);
  upsertProject(project);
  return project;
}

export async function removeProjectRepo(projectId: string, name: string): Promise<Project> {
  const project = await api.removeProjectRepo(projectId, name);
  upsertProject(project);
  return project;
}

export async function grantProjectRepo(projectId: string, name: string): Promise<Project> {
  const project = await api.grantProjectRepo(projectId, name);
  upsertProject(project);
  return project;
}

/** "GitHub acme/web", "gitlab.com/x/api" or "~/code/mobile": what a repo is, in a row's second line. */
export function repoSourceLabel(repo: ProjectRepo): string {
  if (repo.kind === "folder") return tildePath(repo.source);
  return /^[\w.-]+\/[\w.-]+$/.test(repo.source) ? `GitHub ${repo.source}` : repo.source.replace(/^[a-z]+:\/\//i, "").replace(/\.git$/i, "");
}

/** The repos a task in the project can pick from: only worth a picker when there are several. */
export function pickableRepos(project: Project | null | undefined): ProjectRepo[] {
  const repos = project?.repos ?? [];
  return repos.length > 1 ? repos : [];
}
