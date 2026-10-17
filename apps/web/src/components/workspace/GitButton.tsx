import { useCallback, useEffect, useRef, useState } from "react";
import { DropdownMenu } from "radix-ui";
import { toast } from "sonner";
import { ArrowDownToLine, ArrowUpFromLine, ChevronDown, GitCommitHorizontal, GitPullRequestDraft, LoaderCircle, RefreshCw } from "lucide-react";
import type { Conversation } from "@tot/shared/types";
import type { WorkspaceGit, WorkspaceGitResult } from "@tot/shared/workspace";
import { errorMessage } from "../../lib/api";
import { workspaceApi } from "../../lib/workspace";
import { ConfirmDialog } from "../ConfirmDialog";
import { Button } from "../ui/Button";
import { Callout } from "../ui/Callout";
import { Modal, ModalBody, ModalFooter } from "../ui/Modal";
import { useWorkspaceRefresh } from "./useWorkspaceRefresh";

type Flavor = "commit" | "push" | "pr";

const FLAVORS: Record<Flavor, { title: string; verb: string }> = {
  commit: { title: "Commit changes", verb: "Commit" },
  push: { title: "Commit and push", verb: "Commit and push" },
  pr: { title: "Commit, push and open a pull request", verb: "Commit and open PR" },
};

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

function done(result: WorkspaceGitResult): void {
  if (result.pr) {
    const url = result.pr.url;
    toast.success(`Opened draft PR #${result.pr.number}`, { action: { label: "Open", onClick: () => window.open(url, "_blank", "noopener,noreferrer") } });
  } else {
    toast.success(result.summary);
  }
}

/** The one thing to do now: commit what changed, push what's committed, pull what's new, or else sync. */
function primaryOf(git: WorkspaceGit): { label: string; kind: "commit" | "push" | "pull" | "sync" } {
  if (git.changes) return { label: "Commit", kind: "commit" };
  if (git.ahead || (!git.upstream && git.branch && git.branch !== git.defaultBranch)) return { label: "Push", kind: "push" };
  if (git.behind) return { label: "Pull", kind: "pull" };
  return { label: "Sync", kind: "sync" };
}

/** Writing the commit: a suggested message (editable), and what happens after; pushing to the default branch says so. */
function CommitDialog({
  chatId,
  git,
  flavor,
  onClose,
  onDone,
}: {
  chatId: string;
  git: WorkspaceGit;
  flavor: Flavor;
  onClose: () => void;
  onDone: (result: WorkspaceGitResult) => void;
}) {
  const [message, setMessage] = useState("");
  const [suggesting, setSuggesting] = useState(true);
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const typed = useRef(false);
  const pushing = flavor !== "commit";
  const toDefault = pushing && Boolean(git.branch) && git.branch === git.defaultBranch;

  useEffect(() => {
    let live = true;
    workspaceApi
      .suggestCommitMessage(chatId)
      .then(({ message: suggested }) => {
        if (live && !typed.current && suggested) setMessage(suggested);
      })
      .catch(() => {})
      .finally(() => live && setSuggesting(false));
    return () => {
      live = false;
    };
  }, [chatId]);

  const submit = async () => {
    setWorking(true);
    setProblem(null);
    try {
      onDone(await workspaceApi.commit(chatId, { message, push: pushing, pr: flavor === "pr", confirmDefault: toDefault }));
    } catch (error) {
      setProblem(errorMessage(error));
      setWorking(false);
    }
  };

  return (
    <Modal
      open
      onOpenChange={(open) => !open && !working && onClose()}
      title={FLAVORS[flavor].title}
      description={`${plural(git.changes, "file")} on ${git.branch ?? "a detached HEAD"}`}
      className="max-w-lg"
    >
      <ModalBody>
        <textarea
          autoFocus
          rows={5}
          value={message}
          onChange={(event) => {
            typed.current = true;
            setMessage(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && message.trim() && !working) void submit();
          }}
          placeholder={suggesting ? "Writing a message…" : "What changed, in a line"}
          aria-label="Commit message"
          className="input min-h-28 resize-y rounded-xl font-mono text-ui leading-relaxed"
        />
        {toDefault && <Callout tone="warning">This pushes straight to {git.branch}, the repo's default branch.</Callout>}
        {problem && <Callout tone="danger">{problem}</Callout>}
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" onClick={onClose} disabled={working}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => void submit()} disabled={!message.trim() || working}>
          {working ? "Working…" : toDefault ? `${FLAVORS[flavor].verb} to ${git.branch}` : FLAVORS[flavor].verb}
        </Button>
      </ModalFooter>
    </Modal>
  );
}

/**
 * Git for the chat's folder, in the panel's header: the action that fits now as one button (commit, push, pull or
 * sync), the rest in its menu. Committing asks for a message, suggested from the diff; a push to the repo's
 * default branch is confirmed first.
 */
export function GitButton({ chat }: { chat: Conversation }) {
  const [git, setGit] = useState<WorkspaceGit | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [flavor, setFlavor] = useState<Flavor | null>(null);
  const [confirm, setConfirm] = useState<"push" | "sync" | null>(null);

  const load = useCallback(async () => {
    try {
      setGit(await workspaceApi.git(chat.id));
    } catch {
      setGit(null);
    }
  }, [chat.id]);
  useEffect(() => void load(), [load]);
  useWorkspaceRefresh(chat.id, () => void load());

  const run = async (label: string, action: () => Promise<WorkspaceGitResult>) => {
    setBusy(label);
    try {
      const result = await action();
      setGit(result.git);
      done(result);
    } catch (error) {
      toast.error(errorMessage(error));
      void load();
    } finally {
      setBusy(null);
    }
  };

  if (!git) return null;
  const onDefault = Boolean(git.branch) && git.branch === git.defaultBranch;
  const push = (confirmed = false) => {
    if (onDefault && !confirmed) return setConfirm("push");
    void run("Pushing…", () => workspaceApi.push(chat.id, confirmed));
  };
  const sync = (confirmed = false) => {
    if (onDefault && !confirmed && (git.ahead || !git.upstream)) return setConfirm("sync");
    void run("Syncing…", () => workspaceApi.sync(chat.id, confirmed));
  };
  const pull = () => void run("Pulling…", () => workspaceApi.pull(chat.id));
  const primary = primaryOf(git);
  const act = () => (primary.kind === "commit" ? setFlavor("commit") : primary.kind === "push" ? push() : primary.kind === "pull" ? pull() : sync());
  const state = [git.branch ?? "detached", git.ahead ? `${git.ahead} ahead` : "", git.behind ? `${git.behind} behind` : ""].filter(Boolean).join(" · ");

  return (
    <>
      <div className="inline-flex h-8 shrink-0 items-stretch overflow-hidden rounded-full border border-edge bg-fill-subtle text-ui font-medium text-fg">
        <button type="button" onClick={act} disabled={Boolean(busy)} title={state} className="flex items-center gap-1.5 pr-2.5 pl-3 transition-colors hover:bg-hover active:bg-selected disabled:opacity-60">
          {busy ? <LoaderCircle className="size-3.5 animate-spin text-fg-subtle" /> : null}
          {busy ?? primary.label}
          {!busy && primary.kind === "commit" && <span className="text-fg-subtle tabular-nums">{git.changes}</span>}
        </button>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button type="button" aria-label="More git actions" disabled={Boolean(busy)} className="flex items-center border-l border-edge px-1.5 text-fg-muted transition-colors hover:bg-hover hover:text-fg data-[state=open]:bg-selected">
              <ChevronDown className="size-3.5" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="menu w-64" sideOffset={4} align="end">
              <DropdownMenu.Label className="menu-label truncate">{state}</DropdownMenu.Label>
              <DropdownMenu.Item className="menu-item" disabled={!git.changes} onSelect={() => setFlavor("commit")}>
                <GitCommitHorizontal className="size-4 text-fg-muted" /> Commit…
              </DropdownMenu.Item>
              <DropdownMenu.Item className="menu-item" disabled={!git.changes} onSelect={() => setFlavor("push")}>
                <ArrowUpFromLine className="size-4 text-fg-muted" /> Commit and push…
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className="menu-item"
                disabled={!git.changes || !git.canOpenPr || onDefault}
                title={!git.canOpenPr ? (git.prProblem ?? undefined) : onDefault ? `Make a branch other than ${git.branch} first.` : undefined}
                onSelect={() => setFlavor("pr")}
              >
                <GitPullRequestDraft className="size-4 text-fg-muted" /> Commit, push and open PR…
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="menu-separator" />
              <DropdownMenu.Item className="menu-item" disabled={!git.upstream} onSelect={pull}>
                <ArrowDownToLine className="size-4 text-fg-muted" /> Pull
              </DropdownMenu.Item>
              <DropdownMenu.Item className="menu-item" disabled={!git.branch} onSelect={() => push()}>
                <ArrowUpFromLine className="size-4 text-fg-muted" /> Push
              </DropdownMenu.Item>
              <DropdownMenu.Item className="menu-item" disabled={!git.branch} onSelect={() => sync()}>
                <RefreshCw className="size-4 text-fg-muted" /> Sync
              </DropdownMenu.Item>
              {!git.canOpenPr && git.prProblem && <p className="px-2 pt-1.5 pb-1 text-xs leading-relaxed text-fg-subtle">{git.prProblem}</p>}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
      {flavor && (
        <CommitDialog
          chatId={chat.id}
          git={git}
          flavor={flavor}
          onClose={() => setFlavor(null)}
          onDone={(result) => {
            setFlavor(null);
            setGit(result.git);
            done(result);
          }}
        />
      )}
      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
        title={`Push to ${git.branch}?`}
        description={`This pushes straight to ${git.branch}, the repo's default branch, without a pull request.`}
        confirmLabel={`Push to ${git.branch}`}
        onConfirm={() => (confirm === "sync" ? sync(true) : push(true))}
      />
    </>
  );
}
