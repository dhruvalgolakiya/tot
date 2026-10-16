import { useState } from "react";
import type { MemoryImportStatus, MemorySkippedMemory } from "@tot/shared/types";
import { api } from "../../lib/api";
import { notifyError } from "../../store";
import { ConfirmDialog } from "../ConfirmDialog";
import { Button } from "../ui/Button";
import { Callout } from "../ui/Callout";
import { LedgerGroup, ledgerRowClass } from "../ui/Ledger";

const day = (time: number) => new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

/**
 * The one-time import of the memories from before memory became a repo (roadmap module 10), when it needs the
 * user: why it failed (it's tried again at the next start, and agents read the old memories meanwhile), and the
 * old memories it left out because they looked like secrets, each to import anyway (unless it holds a key) or drop.
 */
export function MemoryImport({ status, onChanged }: { status: MemoryImportStatus; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [dropping, setDropping] = useState<MemorySkippedMemory | null>(null);
  const failed = status.done ? null : status.error;
  if (!failed && !status.skipped.length) return null;

  async function act(id: string, run: () => Promise<unknown>) {
    setBusy(id);
    try {
      await run();
      onChanged();
    } catch (error) {
      notifyError(error);
    } finally {
      setBusy(null);
    }
  }

  const count = status.skipped.length;
  return (
    <section className="space-y-3">
      {failed && (
        <Callout tone="danger">
          Couldn't move your memories into the repo ({failed.replace(/\.$/, "")}). TOT tries again the next time it starts; until then agents read them as they were.
        </Callout>
      )}
      {count > 0 && (
        <LedgerGroup body="rows"
          title="Skipped"
          count={count}
         
          description={count === 1 ? "1 memory wasn't imported because it looks like a secret." : `${count} memories weren't imported because they look like secrets.`}
        >
          <ul>
            {status.skipped.map((item) => (
              <li key={item.id} className={ledgerRowClass({ className: "group items-start" })}>
                <div className="min-w-0 flex-1">
                  <p className="text-sm leading-relaxed text-fg [overflow-wrap:anywhere]">{item.text}</p>
                  <p className="mt-0.5 text-xs text-fg-subtle tabular-nums">
                    {day(item.createdAt)}
                    {!item.importable && " · Holds a key, so it can only be dropped"}
                  </p>
                </div>
                <div className="flex h-7 shrink-0 items-center gap-1">
                  {item.importable && (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy === item.id}
                      onClick={() => void act(item.id, () => api.importSkippedMemory(item.id))}
                      className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
                    >
                      Import anyway
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" disabled={busy === item.id} onClick={() => setDropping(item)}>
                    Drop
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </LedgerGroup>
      )}
      <ConfirmDialog
        open={Boolean(dropping)}
        onOpenChange={(open) => !open && setDropping(null)}
        title="Drop this memory?"
        description="It's deleted for good; it never reaches memory."
        confirmLabel="Drop"
        onConfirm={() => dropping && void act(dropping.id, () => api.dropSkippedMemory(dropping.id))}
      />
    </section>
  );
}
