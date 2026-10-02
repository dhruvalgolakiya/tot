import { useState } from "react";
import clsx from "clsx";
import { ChevronRight } from "lucide-react";
import type { HandoffPacket } from "@shared/types";
import { relativeTime } from "../../lib/format";
import { PROVIDER_LABELS } from "../../lib/models";

function List({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-fg-muted">{title}</p>
      <ul className="list-disc space-y-0.5 pl-4 text-ui text-fg">
        {items.map((item, index) => (
          <li key={index}>{item}</li>
        ))}
      </ul>
    </div>
  );
}

/** The task's latest handoff packet, folded by default: what another session or provider would start from. */
export function HandoffSection({ packet }: { packet: HandoffPacket }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="space-y-2">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1.5 text-left"
      >
        <ChevronRight className={clsx("size-3.5 shrink-0 text-fg-subtle transition-transform", open && "rotate-90")} />
        <h3 className="group-label">Handoff</h3>
        <span className="ml-auto text-xs text-fg-subtle">
          {PROVIDER_LABELS[packet.from.provider]} · {relativeTime(packet.createdAt)}
        </span>
      </button>
      {open && (
        <div className="space-y-3 rounded-xl border border-hairline p-3">
          <div className="space-y-1">
            <p className="text-xs font-medium text-fg-muted">Next step</p>
            <p className="text-ui text-fg">{packet.nextStep}</p>
          </div>
          <List title="Done so far" items={packet.doneSoFar} />
          <List title="Decisions" items={packet.decisions.map((d) => `${d.decision} — ${d.why}`)} />
          <List title="Files" items={packet.files.map((f) => `${f.path}: ${f.change}`)} />
          <List title="Tests" items={packet.tests.map((t) => `${t.command} · ${t.status}${t.note ? ` — ${t.note}` : ""}`)} />
          <List title="Open questions" items={packet.openQuestions} />
          {packet.repo && (
            <p className="font-mono text-xs break-all text-fg-subtle">
              {packet.repo.branch} @ {packet.repo.headSha.slice(0, 8)}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
