import { useEffect, useMemo, useState, type ReactNode } from "react";
import clsx from "clsx";
import { Popover } from "radix-ui";
import { BookOpen, Check, ChevronDown, FolderGit2, Lock } from "lucide-react";
import type { GitHubRepo } from "@shared/types";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { api } from "../../lib/api";
import { repoLabel } from "../../lib/tasks";
import { useStore } from "../../store";
import { GitHubMark } from "../ui/GitHubMark";
import { SearchInput } from "../ui/SearchInput";

/** A git URL, an SSH remote, a folder path, or "owner/name": usable as typed. */
const TYPED_SOURCE = /^(?:[a-z][a-z0-9+.-]*:\/\/\S+|[\w.-]+@[\w.-]+:\S+|[~./]\S*|[\w.-]+\/[\w.-]+)$/i;

type Option = { value: string; label: ReactNode; detail?: string; icon: ReactNode };

/**
 * Which repo a task works on: the agent's repo brains (repos it has learned), the user's GitHub
 * repos when GitHub is connected (the same list Learn a repo shows), or anything typed — a URL,
 * "owner/name", or a folder on the agent's computer. "" means no repo: a task without code.
 */
function RepoSearch({ agentId, value, onChange }: { agentId: string | null; value: string; onChange: (value: string) => void }) {
  const brains = useStore((s) => s.brains);
  const github = useStore((s) => s.github?.connection ?? null);
  const [query, setQuery] = useState("");
  const typed = query.trim();
  const debounced = useDebouncedValue(TYPED_SOURCE.test(typed) ? "" : typed, 250);
  const [repos, setRepos] = useState<GitHubRepo[] | null>(null);

  useEffect(() => {
    if (!github) return;
    let cancelled = false;
    api.listGithubRepos(debounced || undefined).then(
      (list) => !cancelled && setRepos(list.slice(0, 20)),
      () => !cancelled && setRepos([]),
    );
    return () => {
      cancelled = true;
    };
  }, [github, debounced]);

  const learned = useMemo(
    () =>
      (brains ?? []).filter(
        (brain) =>
          brain.kind === "repo" &&
          brain.source &&
          (brain.allAgents || brain.agents.some((a) => a.agentId === agentId)) &&
          (!typed || `${brain.name} ${brain.source}`.toLowerCase().includes(typed.toLowerCase())),
      ),
    [brains, agentId, typed],
  );

  const options: Option[] = [
    ...(typed && TYPED_SOURCE.test(typed) ? [{ value: typed, label: <>Use “{typed}”</>, icon: <FolderGit2 /> }] : []),
    ...learned.map((brain) => ({ value: brain.source!, label: brain.name, detail: "Learned", icon: <BookOpen /> })),
    ...(repos ?? [])
      .filter((repo) => !learned.some((brain) => brain.source && repoLabel(brain.source) === repo.fullName))
      .map((repo) => ({ value: repo.fullName, label: repo.fullName, detail: repo.private ? "Private" : undefined, icon: repo.private ? <Lock /> : <GitHubMark /> })),
  ];

  return (
    <div className="space-y-1">
      <SearchInput
        compact
        autoFocus
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && typed) {
            event.preventDefault();
            onChange(options[0]?.value ?? typed);
          }
        }}
        placeholder={github ? "Search repos, or paste a URL or folder" : "Paste a URL, owner/name, or folder"}
        aria-label="Repository"
      />
      <div role="listbox" aria-label="Repositories" className="max-h-64 overflow-y-auto">
        <RepoOption selected={!value} onSelect={() => onChange("")} icon={<span className="size-4" />} label="No repo" detail="Not a coding task" />
        {options.map((option) => (
          <RepoOption key={option.value} selected={value === option.value} onSelect={() => onChange(option.value)} {...option} />
        ))}
        {github && repos === null && <p className="px-2.5 py-2 text-xs text-fg-subtle">Loading your repos…</p>}
      </div>
    </div>
  );
}

function RepoOption({ selected, onSelect, icon, label, detail }: { selected: boolean; onSelect: () => void } & Omit<Option, "value">) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onSelect}
      className={clsx("menu-item w-full", selected && "bg-selected")}
    >
      <span className="grid size-4 shrink-0 place-items-center text-fg-muted [&_svg]:size-3.5">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-left text-sm">{label}</span>
      {detail && <span className="shrink-0 text-xs text-fg-subtle">{detail}</span>}
      <Check className={clsx("size-4 shrink-0 text-fg", !selected && "invisible")} />
    </button>
  );
}

/** The composer's repo chip: "No repo" or the chosen one; opens the search. */
export function RepoChip({ agentId, value, onChange }: { agentId: string | null; value: string; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button
          type="button"
          className="flex h-9 max-w-48 items-center gap-1.5 rounded-full px-3 text-ui font-medium text-fg-muted transition-colors hover:bg-hover hover:text-fg data-[state=open]:bg-selected data-[state=open]:text-fg"
        >
          <FolderGit2 className="size-3.5 shrink-0" />
          <span className="truncate">{value ? repoLabel(value) : "No repo"}</span>
          <ChevronDown className="size-3.5 shrink-0 text-fg-subtle" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" side="top" sideOffset={6} collisionPadding={8} className="menu w-80 p-1.5">
          <RepoSearch
            agentId={agentId}
            value={value}
            onChange={(next) => {
              onChange(next);
              setOpen(false);
            }}
          />
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** The same search inline, for dialogs. */
export function RepoField({ agentId, value, onChange }: { agentId: string | null; value: string; onChange: (value: string) => void }) {
  return (
    <div className="rounded-xl border border-hairline p-1.5">
      <RepoSearch agentId={agentId} value={value} onChange={onChange} />
    </div>
  );
}
