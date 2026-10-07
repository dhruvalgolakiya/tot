import { useCallback, useEffect, useState, type ComponentType } from "react";
import clsx from "clsx";
import {
  CalendarClock,
  CircleCheck,
  CircleX,
  ExternalLink,
  GitMerge,
  GitPullRequestArrow,
  GitPullRequestClosed,
  MessageSquare,
  MessageSquareDiff,
  MessageSquareText,
  RefreshCw,
  Ticket,
} from "lucide-react";
import { toast } from "sonner";
import type { LeadSignal, LeadSignalKind, Project } from "@shared/types";
import { useNow } from "../../hooks/useNow";
import { api } from "../../lib/api";
import { relativeTime } from "../../lib/format";
import { notifyError, useStore } from "../../store";
import { Callout } from "../ui/Callout";
import { cardClass } from "../ui/Card";
import { IconButton } from "../ui/IconButton";
import { Tip } from "../ui/Tip";

/**
 * Module 12 (docs/roadmap/12-coordinator.md), lane A: the last things the project's Lead heard about on its own (on
 * the Board tab): a pull request's checks, reviews, comments, merge or conflict, a ticket, a schedule. Quiet rows
 * (icon, title, repo, time, a link on hover), the unread ones (the Lead hasn't had a turn with them yet) marked with
 * a dot. Reloads when the Lead's chat changes, which every new signal (a note there) and every turn that reads them
 * does. Knowledge of a project on another device stays there: nothing for one.
 */

const ICONS: Record<LeadSignalKind, ComponentType<{ className?: string }>> = {
  "ci-failed": CircleX,
  "ci-passed": CircleCheck,
  "changes-requested": MessageSquareDiff,
  "review-comment": MessageSquareText,
  comment: MessageSquare,
  "pr-merged": GitMerge,
  "pr-closed": GitPullRequestClosed,
  "pr-conflict": GitPullRequestArrow,
  ticket: Ticket,
  schedule: CalendarClock,
};

/** Status colors only where the signal is a status. */
const TONES: Partial<Record<LeadSignalKind, string>> = { "ci-failed": "text-danger", "ci-passed": "text-success", "pr-conflict": "text-warning" };

const PAGE = 8;

const hasGitHub = (project: Project) =>
  (project.repos?.length ? project.repos.some((repo) => repo.kind === "github") : project.kind === "github") && Boolean(project.leadChatId);

export function ProjectSignals({ project }: { project: Project }) {
  const remote = Boolean(project.deviceId);
  const leadId = project.leadChatId ?? null;
  // Every new signal is a note in the Lead's chat, and every turn that reads them changes it: reload then.
  const leadVersion = useStore((s) => (leadId ? s.conversations.find((c) => c.id === leadId)?.updatedAt : undefined));
  const [signals, setSignals] = useState<LeadSignal[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const [checking, setChecking] = useState(false);
  const now = useNow(Boolean(signals?.length), 60_000);

  const load = useCallback(async () => {
    try {
      setSignals(await api.getProjectSignals(project.id));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [project.id]);

  useEffect(() => {
    if (!remote) void load();
  }, [load, leadVersion, remote]);

  if (remote || (!leadId && !signals?.length)) return null;
  const watching = (project.subscriptions?.pullRequests ?? "tot") !== "off";
  const unread = signals?.filter((signal) => signal.readAt === null).length ?? 0;
  const shown = signals?.slice(0, limit) ?? [];

  async function checkNow() {
    setChecking(true);
    try {
      const after = await api.checkProjectSignals(project.id);
      const fresh = after.filter((signal) => !signals?.some((known) => known.id === signal.id)).length;
      setSignals(after);
      if (!fresh) toast.success("Nothing new");
    } catch (err) {
      notifyError(err);
    } finally {
      setChecking(false);
    }
  }

  return (
    <section aria-labelledby="board-signals" className="space-y-2">
      <div className="flex min-h-7 items-center justify-between gap-2">
        <h3 id="board-signals" className="flex items-baseline gap-2 text-ui font-semibold text-fg">
          Signals
          {unread > 0 && <span className="text-xs font-normal text-fg-subtle tabular-nums">{unread} new</span>}
        </h3>
        {watching && hasGitHub(project) && (
          <Tip content="Look at pull requests now">
            <IconButton size="sm" label="Look at pull requests now" disabled={checking} onClick={() => void checkNow()}>
              <RefreshCw className={clsx(checking && "animate-spin")} />
            </IconButton>
          </Tip>
        )}
      </div>
      {failed && !signals && (
        <Callout
          tone="danger"
          action={
            <button type="button" className="link-muted" onClick={() => void load()}>
              Try again
            </button>
          }
        >
          Couldn't load the signals.
        </Callout>
      )}
      {signals && !signals.length && (
        <p className="text-xs leading-relaxed text-fg-subtle">
          {watching
            ? "When a pull request's checks or reviews change, or a ticket or schedule comes in, the Lead hears about it, and it shows here."
            : "When a ticket or schedule comes in, the Lead hears about it, and it shows here. Pull requests aren't watched for this project."}
        </p>
      )}
      {shown.length > 0 && (
        <ul className={cardClass({ padding: "none" })}>
          {shown.map((signal, index) => (
            <SignalRow key={signal.id} signal={signal} first={index === 0} now={now} />
          ))}
        </ul>
      )}
      {(signals?.length ?? 0) > limit && (
        <button type="button" className="link-muted text-xs" onClick={() => setLimit((n) => n + 20)}>
          Show older signals
        </button>
      )}
    </section>
  );
}

function SignalRow({ signal, first, now }: { signal: LeadSignal; first: boolean; now: number }) {
  const Icon = ICONS[signal.kind] ?? MessageSquare;
  const unread = signal.readAt === null;
  const meta = [signal.repoName, relativeTime(signal.at, now)].filter(Boolean).join(" · ");
  return (
    <li className={clsx("group flex items-start gap-3 px-3 py-2.5", !first && "border-t border-hairline")}>
      <Icon className={clsx("mt-0.5 size-4 shrink-0", TONES[signal.kind] ?? "text-fg-subtle")} />
      <div className="min-w-0 flex-1">
        <p className={clsx("line-clamp-2 text-ui [overflow-wrap:anywhere]", unread ? "font-medium text-fg" : "text-fg-muted")} title={signal.detail ?? undefined}>
          {signal.title}
        </p>
        <p className="mt-0.5 flex items-center gap-1.5 text-xs text-fg-subtle tabular-nums">
          {unread && (
            <>
              <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-accent" />
              <span className="sr-only">New:</span>
            </>
          )}
          <span className="truncate">{meta}</span>
        </p>
      </div>
      {signal.url && (
        <a
          href={signal.url}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open “${signal.title}”`}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-fg-muted opacity-0 transition-opacity group-hover:opacity-100 hover:bg-hover hover:text-fg focus-visible:opacity-100 pointer-coarse:opacity-100 [&_svg]:size-3.5"
        >
          <ExternalLink />
        </a>
      )}
    </li>
  );
}
