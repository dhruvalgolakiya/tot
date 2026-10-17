import { useCallback, useEffect, useMemo, useState } from "react";
import { GitCompare, RefreshCw } from "lucide-react";
import type { Conversation } from "@tot/shared/types";
import type { WorkspaceChange, WorkspaceDiff, WorkspaceFileDiff, WorkspaceInfo } from "@tot/shared/workspace";
import { errorMessage } from "../../lib/api";
import { workspaceApi } from "../../lib/workspace";
import { Callout } from "../ui/Callout";
import { EmptyState } from "../ui/EmptyState";
import { IconButton } from "../ui/IconButton";
import { Skeleton } from "../ui/Skeleton";
import { Tip } from "../ui/Tip";
import { DiffView } from "./DiffView";
import { FileTree, treeOrder } from "./FileTree";
import { useWorkspaceRefresh } from "./useWorkspaceRefresh";

const STATUS: Record<WorkspaceChange["status"], string> = { added: "Added", modified: "Changed", deleted: "Deleted", renamed: "Renamed", untracked: "New" };

type Loaded<T> = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; value: T };

function Counts({ change }: { change: Pick<WorkspaceChange, "added" | "removed" | "binary"> }) {
  if (change.binary) return <span className="text-2xs text-fg-subtle">binary</span>;
  return (
    <span className="flex shrink-0 gap-1.5 text-2xs tabular-nums">
      {change.added > 0 && <span className="text-success">+{change.added}</span>}
      {change.removed > 0 && <span className="text-danger">−{change.removed}</span>}
    </span>
  );
}

/** The selected file's diff, loaded again whenever the list is (`version`). */
function FilePatch({ chatId, change, version }: { chatId: string; change: WorkspaceChange; version: number }) {
  const [state, setState] = useState<Loaded<WorkspaceFileDiff> & { key?: string }>({ status: "loading" });
  const key = `${change.path}\0${change.oldPath ?? ""}`;
  useEffect(() => {
    let live = true;
    workspaceApi.diffFile(chatId, change.path, change.oldPath).then(
      (value) => live && setState({ status: "ready", value, key }),
      (error) => live && setState({ status: "error", message: errorMessage(error), key }),
    );
    return () => {
      live = false;
    };
  }, [chatId, key, change.path, change.oldPath, version]);
  const shown = state.key === key ? state : { status: "loading" as const };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-hairline px-3">
        <span className="min-w-0 truncate font-mono text-ui text-fg" title={change.path}>
          {change.oldPath ? `${change.oldPath} → ${change.path}` : change.path}
        </span>
        <span className="shrink-0 text-xs text-fg-subtle">{STATUS[change.status]}</span>
        <span className="ml-auto" />
        <Counts change={change} />
      </div>
      {shown.status === "loading" ? (
        <div className="space-y-1.5 p-3" aria-busy="true" aria-label="Loading the diff">
          <Skeleton className="h-3.5 w-3/4" />
          <Skeleton className="h-3.5 w-1/2" />
          <Skeleton className="h-3.5 w-2/3" />
        </div>
      ) : shown.status === "error" ? (
        <div className="p-3">
          <Callout tone="danger">{shown.message}</Callout>
        </div>
      ) : shown.value.binary ? (
        <EmptyState variant="quiet" title="A binary file changed." className="m-2" />
      ) : !shown.value.patch.trim() ? (
        <EmptyState variant="quiet" title="Nothing to show for this file." className="m-2" />
      ) : (
        <>
          <DiffView path={change.path} patch={shown.value.patch} />
          {shown.value.truncated && <p className="shrink-0 border-t border-hairline px-3 py-2 text-xs text-fg-subtle">Only the start of this diff is shown; it's very large.</p>}
        </>
      )}
    </div>
  );
}

/**
 * What changed in the chat's folder since its last commit: changed and new files as a tree with +/− counts,
 * and the selected file's diff. Refreshes as files change, after each turn and when the window comes back.
 */
export function DiffTab({ chat, info }: { chat: Conversation; info: WorkspaceInfo }) {
  const [state, setState] = useState<Loaded<WorkspaceDiff>>({ status: "loading" });
  const [selected, setSelected] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const value = await workspaceApi.diff(chat.id);
      setState({ status: "ready", value });
      setVersion((current) => current + 1);
    } catch (error) {
      setState((current) => (current.status === "ready" ? current : { status: "error", message: errorMessage(error) }));
    } finally {
      setRefreshing(false);
    }
  }, [chat.id]);

  useEffect(() => {
    if (info.git) void load();
  }, [load, info.git]);
  useWorkspaceRefresh(chat.id, () => void (info.git && load()));

  const files = state.status === "ready" ? state.value.files : [];
  const byPath = useMemo(() => new Map(files.map((file) => [file.path, file])), [files]);
  const paths = useMemo(() => files.map((file) => file.path), [files]);
  const first = useMemo(() => treeOrder(paths)[0], [paths]);
  const change = (selected && byPath.get(selected)) || (first && byPath.get(first)) || null;
  const totals = useMemo(() => files.reduce((sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed }), { added: 0, removed: 0 }), [files]);

  if (!info.git) {
    return <EmptyState size="sm" icon={<GitCompare />} title="Not a git repo" description="Changes show here once this folder is a git repo." />;
  }
  if (state.status === "loading") {
    return (
      <div className="space-y-2 p-4" aria-busy="true" aria-label="Loading changes">
        <Skeleton className="h-4 w-1/3" />
        <Skeleton className="h-4 w-1/2" />
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="p-4">
        <Callout tone="danger" action={<button type="button" className="link-muted" onClick={() => void load()}>Try again</button>}>
          {state.message}
        </Callout>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-hairline pr-2 pl-4 text-ui">
        <span className="text-fg-muted">
          {files.length ? `${files.length}${state.value.truncated ? "+" : ""} ${files.length === 1 ? "file" : "files"} changed` : "No changes"}
        </span>
        {files.length > 0 && <Counts change={{ ...totals, binary: false }} />}
        {state.value.branch && <span className="min-w-0 truncate text-xs text-fg-subtle">on {state.value.branch}</span>}
        <Tip content="Refresh">
          <IconButton size="sm" label="Refresh changes" className="ml-auto" onClick={() => void load()} disabled={refreshing}>
            <RefreshCw className={refreshing ? "animate-spin" : undefined} />
          </IconButton>
        </Tip>
      </div>
      {files.length === 0 ? (
        <EmptyState size="sm" icon={<GitCompare />} title="No changes yet" description="Files the agent or you change in this folder show up here." />
      ) : (
        <>
          <FileTree
            label="Changed files"
            paths={paths}
            selected={change?.path ?? null}
            onOpen={setSelected}
            trailing={(path) => <Counts change={byPath.get(path)!} />}
            className="max-h-[38%] shrink-0 border-b border-hairline py-1"
          />
          {change && <FilePatch key={change.path} chatId={chat.id} change={change} version={version} />}
        </>
      )}
    </div>
  );
}
