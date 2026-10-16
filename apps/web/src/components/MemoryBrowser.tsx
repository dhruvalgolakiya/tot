import { useCallback, useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import type { MemoryRepoSummary } from "@shared/types";
import { useCopy } from "../hooks/useCopy";
import { api, errorMessage } from "../lib/api";
import { useMemoryUi } from "../lib/memory";
import { goToSettings, useStore } from "../store";
import { MemoryDreaming } from "./memory/MemoryDreaming";
import { MemoryEntries } from "./memory/MemoryEntries";
import { MemoryHistory } from "./memory/MemoryHistory";
import { MemoryImport } from "./memory/MemoryImport";
import { MemorySync } from "./memory/MemorySync";
import { Callout } from "./ui/Callout";
import { IconButton } from "./ui/IconButton";
import { Skeleton } from "./ui/Skeleton";
import { Tip } from "./ui/Tip";

const SKILL_COMMAND = "npx skills add AgentMemoryRepo/agentmemoryrepo --skill agent-memory-repo";

/**
 * Settings → Memory (roadmap module 10): what every agent knows about the user, the "you" memory repo (a git repo of
 * markdown): its entries, history with Undo, Dreaming, sync with paired devices, and what the one-time import left
 * to decide. A project's own facts and pages are on its Knowledge page, not here.
 */
export function MemoryBrowser() {
  const memoryEnabled = useStore((s) => s.settings?.memory.enabled ?? true);
  const changes = useMemoryUi((s) => Object.values(s.versions).reduce((sum, n) => sum + n, 0));
  const [summary, setSummary] = useState<MemoryRepoSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const repos = await api.memoryRepos();
      setSummary(repos.find((repo) => repo.kind === "you") ?? null);
      setError(null);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, changes]);

  // A dream that changes nothing sends no event: follow it until it's done.
  const dreaming = summary?.dream.running ?? false;
  useEffect(() => {
    if (!dreaming) return;
    const timer = window.setInterval(() => void load(), 2000);
    return () => window.clearInterval(timer);
  }, [dreaming, load]);

  if (error && !summary) {
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

  if (!summary) {
    return (
      <div className="space-y-6" aria-busy="true" aria-label="Loading memory">
        <Skeleton className="h-14 w-full rounded-xl" />
        <Skeleton className="h-40 w-full rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
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
      <MemoryEntries key={`entries:${summary.id}`} repo={summary.id} kind={summary.kind} onChanged={load} compact />
      <MemoryHistory key={`history:${summary.id}`} repo={summary.id} onChanged={load} />
      <MemoryDreaming summary={summary} onChanged={load} />
      {summary.sync && <MemorySync sync={summary.sync} onChanged={load} />}
      <OtherTools path={summary.path} />
    </div>
  );
}

/** Where it lives, and how Claude Code, Codex and Cursor can read it too: one quiet line and the command. */
function OtherTools({ path }: { path: string }) {
  const { copied, copy } = useCopy();
  return (
    <section className="space-y-2">
      <p className="text-xs leading-relaxed text-fg-subtle">
        Kept as a git repo at <code className="font-mono text-fg-muted">{path}</code>. Claude Code, Codex and Cursor can read it too:
      </p>
      <div className="flex items-center gap-2 rounded-lg bg-sunken py-1 pr-1 pl-3">
        <code className="min-w-0 flex-1 truncate font-mono text-xs text-fg-muted">{SKILL_COMMAND}</code>
        <Tip content={copied ? "Copied" : "Copy"}>
          <IconButton label="Copy the command" size="sm" onClick={() => void copy(SKILL_COMMAND)}>
            {copied ? <Check /> : <Copy />}
          </IconButton>
        </Tip>
      </div>
    </section>
  );
}
