import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { toast } from "sonner";
import type { LocalSession, LocalSessionList, Project, ProviderId } from "@tot/shared/types";
import { useNow } from "../../hooks/useNow";
import { api, errorMessage } from "../../lib/api";
import { shortTime } from "../../lib/projects";
import { navigateToConversation } from "../../store";
import { ProviderMark } from "../ProviderMark";
import { Button } from "../ui/Button";
import { Callout } from "../ui/Callout";
import { EmptyState } from "../ui/EmptyState";
import { Field } from "../ui/Field";
import { Modal, ModalBody, ModalFooter } from "../ui/Modal";
import { SearchInput } from "../ui/SearchInput";
import { Select } from "../ui/Select";
import { Skeleton } from "../ui/Skeleton";

const PROVIDER_NAMES: Record<ProviderId, string> = { claude: "Claude Code", chatgpt: "Codex" };
/** A list still being read (a very large history) is asked for again this often, this many times. */
const RETRY_MS = 2_000;
const MAX_RETRIES = 5;

type Props = {
  project: Project;
  /** The agent the chats are with (the active one). */
  agentId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function matches(session: LocalSession, query: string): boolean {
  return [session.title, session.firstPrompt, session.branch ?? "", session.accountName].some((text) => text.toLowerCase().includes(query));
}

/**
 * Claude Code and Codex sessions that ran in the project's folders or worktrees, picked and imported as chats in the
 * project. Each chat continues its session where it left off. Sessions in a folder no account uses continue on the
 * account picked here (their files are copied into its folder).
 */
export function ImportSessionsDialog({ project, agentId, open, onOpenChange }: Props) {
  const [list, setList] = useState<LocalSessionList | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [targets, setTargets] = useState<Partial<Record<ProviderId, string>>>({});
  const [importing, setImporting] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const now = useNow(open, 60_000);

  useEffect(() => {
    if (open) return;
    setList(null);
    setError(null);
    setQuery("");
    setChosen(new Set());
    setTargets({});
    setAttempt(0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let timer: number | undefined;
    api.listProjectSessions(project.id).then(
      (next) => {
        if (cancelled) return;
        setList(next);
        if (next.partial && attempt < MAX_RETRIES) timer = window.setTimeout(() => setAttempt((n) => n + 1), RETRY_MS);
      },
      (err: unknown) => !cancelled && setError(errorMessage(err)),
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, project.id, attempt]);

  const sessions = list?.sessions ?? [];
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? sessions.filter((session) => matches(session, q)) : sessions;
  }, [sessions, query]);
  const importable = shown.filter((session) => !session.importedChatId);
  const allChosen = importable.length > 0 && importable.every((session) => chosen.has(session.key));
  // Providers of the picked sessions that sit in a folder no account uses: each needs an account to continue on.
  const unbound = [...new Set(sessions.filter((s) => chosen.has(s.key) && !s.accountId).map((s) => s.driver))];
  const accountsOf = (driver: ProviderId) => (list?.accounts ?? []).filter((account) => account.driver === driver);
  const targetFor = (driver: ProviderId) => targets[driver] ?? accountsOf(driver).find((a) => a.isDefault)?.id ?? accountsOf(driver)[0]?.id ?? "";

  const toggle = (key: string, on: boolean) =>
    setChosen((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });
  const toggleAll = () =>
    setChosen((current) => {
      const next = new Set(current);
      for (const session of importable) {
        if (allChosen) next.delete(session.key);
        else next.add(session.key);
      }
      return next;
    });

  async function run() {
    setImporting(true);
    setError(null);
    try {
      const result = await api.importProjectSessions(project.id, {
        keys: [...chosen],
        ...(agentId ? { agentId } : {}),
        accounts: Object.fromEntries(unbound.map((driver) => [driver, targetFor(driver)])),
      });
      const count = result.imported.length;
      if (!count) {
        setError(result.skipped[0]?.reason ?? "Nothing was imported.");
        return;
      }
      onOpenChange(false);
      if (count === 1) navigateToConversation(result.imported[0]!.conversationId);
      else toast.success(`${count} sessions imported`);
      if (result.skipped.length) toast.warning(`${result.skipped.length} not imported: ${result.skipped[0]!.reason}`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setImporting(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Import sessions"
      description={`Claude Code and Codex sessions that ran in ${project.name}'s folders or worktrees. Each becomes a chat here that picks up where it left off.`}
      className="flex max-w-xl"
    >
      <ModalBody className="space-y-3">
        {error && <Callout tone="danger">{error}</Callout>}
        {!list && !error && (
          <div aria-busy="true" aria-label="Looking for sessions" className="space-y-2">
            <Skeleton className="h-10 rounded-xl" />
            <Skeleton className="h-14 rounded-xl" />
            <Skeleton className="h-14 rounded-xl" />
          </div>
        )}
        {list && !sessions.length && (
          <EmptyState
            variant="quiet"
            className="rounded-xl border border-hairline px-4 py-3"
            title={list.partial ? "Still looking…" : "No sessions here yet"}
            description={`Sessions you run with Claude Code or Codex in ${project.name}'s folders on this Mac, or their worktrees, show up here.`}
          />
        )}
        {sessions.length > 0 && (
          <>
            <SearchInput compact value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search sessions" aria-label="Search sessions" autoFocus />
            <div className="flex items-center justify-between px-1 text-xs text-fg-subtle">
              <span className="tabular-nums">
                {shown.length === sessions.length ? `${sessions.length} sessions` : `${shown.length} of ${sessions.length}`}
                {list?.partial && " · still reading older ones…"}
              </span>
              {importable.length > 0 && (
                <button type="button" onClick={toggleAll} className="link-muted">
                  {allChosen ? "Clear" : "Select all"}
                </button>
              )}
            </div>
            {shown.length ? (
              // The list scrolls in its box, so the account picker below stays in view.
              <ul className="max-h-96 divide-y divide-hairline overflow-y-auto rounded-xl border border-hairline">
                {shown.map((session) => (
                  <SessionRow key={session.key} session={session} now={now} checked={chosen.has(session.key)} onToggle={(on) => toggle(session.key, on)} />
                ))}
              </ul>
            ) : (
              <EmptyState variant="quiet" title={`No sessions match “${query.trim()}”`} />
            )}
          </>
        )}
        {unbound.map((driver) => (
          <Field
            key={driver}
            label={`Continue ${PROVIDER_NAMES[driver]} sessions from other folders on`}
            htmlFor={`import-account-${driver}`}
            hint="Their files are copied into that account's folder. The originals stay as they are."
          >
            <Select
              id={`import-account-${driver}`}
              size="sm"
              value={targetFor(driver)}
              onValueChange={(value) => setTargets((current) => ({ ...current, [driver]: value }))}
              options={accountsOf(driver).map((account) => ({ value: account.id, label: account.name }))}
            />
          </Field>
        ))}
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="primary" disabled={importing || chosen.size === 0} onClick={() => void run()}>
          {importing ? "Importing…" : chosen.size > 1 ? `Import ${chosen.size}` : "Import"}
        </Button>
      </ModalFooter>
    </Modal>
  );
}

function SessionRow({ session, now, checked, onToggle }: { session: LocalSession; now: number; checked: boolean; onToggle: (on: boolean) => void }) {
  const imported = Boolean(session.importedChatId);
  const meta = [session.accountName, session.worktree ? session.branch : null, `${session.messageCount} ${session.messageCount === 1 ? "message" : "messages"}`].filter(Boolean);
  return (
    <li>
      <label className={clsx("flex items-start gap-3 px-4 py-3 transition-colors", imported ? "cursor-default" : "cursor-pointer hover:bg-hover")}>
        <input
          type="checkbox"
          checked={imported || checked}
          disabled={imported}
          onChange={(event) => onToggle(event.target.checked)}
          className="mt-0.5 size-4 shrink-0 accent-fg disabled:opacity-50"
        />
        <span className="min-w-0 flex-1">
          <span className={clsx("block truncate text-sm", imported ? "text-fg-muted" : "text-fg")} title={session.firstPrompt}>
            {session.title}
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-fg-subtle">
            <ProviderMark provider={session.driver} className="size-3 shrink-0" />
            <span className="truncate">{meta.join(" · ")}</span>
          </span>
        </span>
        <span className="shrink-0 pt-0.5 text-xs text-fg-subtle tabular-nums">{imported ? "Imported" : shortTime(session.lastActivityAt, now)}</span>
      </label>
    </li>
  );
}
