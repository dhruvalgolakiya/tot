import { useCallback, useEffect, useState } from "react";
import clsx from "clsx";
import { Check, Copy } from "lucide-react";
import type { MemoryRepoSummary } from "@shared/types";
import { useCopy } from "../hooks/useCopy";
import { api, errorMessage } from "../lib/api";
import { pickMemoryRepo, useMemoryUi } from "../lib/memory";
import { goToSettings, navigateToProject, useStore } from "../store";
import { MemoryDreaming } from "./memory/MemoryDreaming";
import { MemoryEntries } from "./memory/MemoryEntries";
import { MemoryHistory } from "./memory/MemoryHistory";
import { MemoryImport } from "./memory/MemoryImport";
import { MemorySync } from "./memory/MemorySync";
import { Callout } from "./ui/Callout";
import { IconButton } from "./ui/IconButton";
import { LedgerGroup, ledgerRowClass } from "./ui/Ledger";
import { Skeleton } from "./ui/Skeleton";
import { Tip } from "./ui/Tip";

const SKILL_COMMAND = "npx skills add AgentMemoryRepo/agentmemoryrepo --skill agent-memory-repo";

/**
 * Settings → Memory (roadmap module 10): memory is git repos of markdown. Pick a repo (About you, or a
 * project's), then its entries grouped by file, its history with Undo, Dreaming, and (About you) sync with
 * paired devices and the optional backup remote, and what the one-time import left for the user to decide. A
 * project's repo also holds its wiki pages (module 11): its Knowledge panel, on the project's page, shows them all.
 */
export function MemoryBrowser() {
  const memoryEnabled = useStore((s) => s.settings?.memory.enabled ?? true);
  const picked = useMemoryUi((s) => s.repo);
  const changes = useMemoryUi((s) => Object.values(s.versions).reduce((sum, n) => sum + n, 0));
  const [repos, setRepos] = useState<MemoryRepoSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRepos(await api.memoryRepos());
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, changes]);

  // A dream that changes nothing sends no event: follow it until it's done.
  const dreaming = repos?.some((repo) => repo.dream.running) ?? false;
  useEffect(() => {
    if (!dreaming) return;
    const timer = window.setInterval(() => void load(), 2000);
    return () => window.clearInterval(timer);
  }, [dreaming, load]);

  const summary = repos?.find((repo) => repo.id === picked) ?? repos?.[0];
  useEffect(() => {
    if (repos && summary && summary.id !== picked) pickMemoryRepo(summary.id);
  }, [repos, summary, picked]);

  if (error && !repos) {
    return (
      <Callout
        tone="danger"
        action={
          <button type="button" onClick={() => void load()} className="link-muted">
            Try again
          </button>
        }
      >
        Couldn't load memory. {error}
      </Callout>
    );
  }

  if (!repos || !summary) {
    return (
      <div className="space-y-6" aria-busy="true" aria-label="Loading memory">
        <Skeleton className="h-9 w-60 rounded-lg" />
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <RepoHeader repos={repos} summary={summary} />
      {!memoryEnabled && (
        <Callout
          tone="warning"
          action={
            <button type="button" className="link-muted" onClick={() => goToSettings("general")}>
              Turn it on in Settings
            </button>
          }
        >
          Memory is off, so agents won't save or recall anything.
        </Callout>
      )}
      {summary.import && <MemoryImport status={summary.import} onChanged={load} />}
      <MemoryEntries key={`entries:${summary.id}`} repo={summary.id} kind={summary.kind} onChanged={load} />
      <MemoryHistory key={`history:${summary.id}`} repo={summary.id} onChanged={load} />
      <MemoryDreaming summary={summary} onChanged={load} />
      {summary.sync && <MemorySync sync={summary.sync} onChanged={load} />}
    </div>
  );
}

/** Which memory, where it lives, and how other agents can read it. */
function RepoHeader({ repos, summary }: { repos: MemoryRepoSummary[]; summary: MemoryRepoSummary }) {
  const { copied, copy } = useCopy();
  const whose = summary.kind === "you" ? "Your memory" : `${summary.name}'s memory`;

  return (
    <section className="space-y-4">
      <LedgerGroup body="rows" title="Repos" count={repos.length}>
        <ul>
          {repos.map((repo) => {
            const current = repo.id === summary.id;
            return (
              <li key={repo.id}>
                <button
                  type="button"
                  onClick={() => pickMemoryRepo(repo.id)}
                  aria-current={current ? "true" : undefined}
                  className={ledgerRowClass({ interactive: true, className: current ? "bg-selected" : undefined })}
                >
                  <span className="min-w-0 flex-1">
                    <span className={clsx("block truncate text-ui", current ? "text-fg" : "text-fg-muted")}>{repo.name}</span>
                    <span className="block truncate text-xs text-fg-subtle">
                      {repo.kind === "you" ? "What you've told any agent" : "What agents learned in this project"}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-fg-subtle tabular-nums">
                    {repo.entries} {repo.entries === 1 ? "entry" : "entries"}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </LedgerGroup>
      <p className="text-xs leading-relaxed text-fg-subtle">
        {whose} is a git repo at <code className="font-mono text-fg-muted">{summary.path}</code>
        {summary.kind === "project" ? ", on this device only" : ""}. Claude Code, Codex and Cursor can read it too:
      </p>
      <div className="flex items-center gap-2 rounded-lg bg-sunken py-1 pr-1 pl-3">
        <code className="min-w-0 flex-1 truncate font-mono text-xs text-fg-muted">{SKILL_COMMAND}</code>
        <Tip content={copied ? "Copied" : "Copy"}>
          <IconButton label="Copy the command" size="sm" onClick={() => void copy(SKILL_COMMAND)}>
            {copied ? <Check /> : <Copy />}
          </IconButton>
        </Tip>
      </div>
      {summary.kind === "project" && summary.projectId && (
        <p className="text-xs leading-relaxed text-fg-subtle">
          It also holds the project's wiki pages.{" "}
          <button type="button" className="link-muted" onClick={() => navigateToProject(summary.projectId!)}>
            Open its knowledge
          </button>
        </p>
      )}
    </section>
  );
}
