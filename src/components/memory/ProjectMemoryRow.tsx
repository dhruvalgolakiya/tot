import { useEffect, useState } from "react";
import { Brain, ChevronRight } from "lucide-react";
import type { Project } from "@shared/types";
import { api } from "../../lib/api";
import { pickMemoryRepo, projectMemoryRepo, useMemoryUi } from "../../lib/memory";
import { goToSettings } from "../../store";

/**
 * A project's memory (roadmap module 10) on its page: "Memory · 12 entries", opening Settings → Memory with the
 * project picked. Only for this device's projects (memory stays on the device it's on).
 */
export function ProjectMemoryRow({ project }: { project: Project }) {
  const repo = projectMemoryRepo(project.slug);
  const version = useMemoryUi((s) => s.versions[repo] ?? 0);
  const [entries, setEntries] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.memoryRepos().then(
      (repos) => !cancelled && setEntries(repos.find((summary) => summary.id === repo)?.entries ?? 0),
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [repo, version]);

  if (project.deviceId) return null;

  return (
    <button
      type="button"
      onClick={() => {
        pickMemoryRepo(repo);
        goToSettings("memory");
      }}
      className="mt-6 flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-sm text-fg-muted transition-colors hover:bg-hover hover:text-fg"
    >
      <Brain className="size-4 shrink-0" />
      <span>Memory</span>
      {entries !== null && (
        <span className="text-fg-subtle tabular-nums">
          · {entries} {entries === 1 ? "entry" : "entries"}
        </span>
      )}
      <ChevronRight className="ml-auto size-4 shrink-0 text-fg-subtle" />
    </button>
  );
}
