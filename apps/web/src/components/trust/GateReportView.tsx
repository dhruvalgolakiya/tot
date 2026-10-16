import { useState, type ReactNode } from "react";
import { ChevronRight, CircleAlert, CircleCheck, CircleDashed, CircleMinus, CircleX } from "lucide-react";
import clsx from "clsx";
import type { GateName, GateReport, GateResult } from "@tot/shared/types";
import { formatDuration, relativeTime } from "../../lib/format";
import { ToolOutput } from "../ToolOutput";
import { Badge, type BadgeTone } from "../ui/Badge";
import { Card } from "../ui/Card";

export const GATE_LABELS: Record<GateName, string> = {
  typecheck: "Typecheck",
  lint: "Lint",
  test: "Tests",
  build: "Build",
  e2e: "End-to-end",
  repro: "Reproduces the bug",
  scope: "Scope",
  deps: "Dependencies",
  size: "Diff size",
  review: "Review",
};

/** Mirrors the server's rule: a failure blocks unless the base branch fails the same way. */
export function gateBlocks(result: GateResult): boolean {
  if (result.status === "needs-approval") return true;
  return result.status === "fail" && !(result.baseline === "fail" && result.newFailures?.length === 0);
}

type Look = { icon: ReactNode; label: string; tone: BadgeTone };

function look(result: GateResult): Look {
  if (result.status === "pass") return { icon: <CircleCheck className="text-success" />, label: "Passed", tone: "success" };
  if (result.status === "skipped") return { icon: <CircleDashed className="text-fg-subtle" />, label: "Skipped", tone: "neutral" };
  if (result.status === "needs-approval") return { icon: <CircleAlert className="text-warning" />, label: "Needs your OK", tone: "warning" };
  if (!gateBlocks(result)) return { icon: <CircleMinus className="text-fg-subtle" />, label: "Fails on base too", tone: "neutral" };
  return { icon: <CircleX className="text-danger" />, label: "Failed", tone: "danger" };
}

/** Which commit was checked against which base, and whether anything blocks. */
function Summary({ report, baseRef }: { report: GateReport; baseRef?: string }) {
  const results = report.results;
  const waiting = results.filter((r) => r.status === "needs-approval").length;
  const failing = results.filter((r) => r.status === "fail" && gateBlocks(r)).length;
  const problems = [
    failing && `${failing} ${failing === 1 ? "check" : "checks"} failed`,
    waiting && `${failing ? waiting : `${waiting} ${waiting === 1 ? "check" : "checks"}`} need${waiting === 1 ? "s" : ""} your OK`,
  ].filter(Boolean);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <Badge tone={report.ok ? "success" : failing ? "danger" : "warning"} dot>
        {report.ok ? "All checks pass" : problems.join(", ")}
      </Badge>
      <span className="text-xs text-fg-subtle tabular-nums">
        {report.headSha ? <span className="font-mono">{report.headSha.slice(0, 7)}</span> : "Uncommitted work"}
        {report.baseSha && (
          <>
            {" "}
            vs {baseRef ?? "base"} <span className="font-mono">{report.baseSha.slice(0, 7)}</span>
          </>
        )}
        {" · "}
        {relativeTime(report.at)}
      </span>
    </div>
  );
}

/** A gate report: one row per check with its pill and duration; a row with output or findings expands. */
export function GateReportView({ report, baseRef }: { report: GateReport; baseRef?: string }) {
  return (
    <section aria-label="Checks" className="space-y-3">
      <Summary report={report} baseRef={baseRef} />
      <Card padding="none" className="divide-y divide-hairline overflow-hidden">
        {report.results.map((result) => (
          <GateRow key={result.gate} result={result} />
        ))}
      </Card>
    </section>
  );
}

function GateRow({ result }: { result: GateResult }) {
  const { icon, label, tone } = look(result);
  const expandable = Boolean(result.outputTail || result.details?.length || result.newFailures?.length || result.command);
  // Problems open by default, so what blocks is visible without a click.
  const [open, setOpen] = useState(gateBlocks(result) && expandable);

  const head = (
    <>
      <span className="mt-0.5 flex shrink-0 [&_svg]:size-4">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-fg">{GATE_LABELS[result.gate]}</span>
        {result.note && <span className="mt-0.5 block text-xs leading-relaxed text-fg-subtle">{result.note}</span>}
      </span>
      <span className="flex shrink-0 items-center gap-2">
        {result.durationMs !== undefined && <span className="text-xs text-fg-subtle tabular-nums">{formatDuration(result.durationMs)}</span>}
        <Badge tone={tone}>{label}</Badge>
        {expandable && <ChevronRight aria-hidden="true" className={clsx("size-4 text-fg-subtle transition-transform duration-150", open && "rotate-90")} />}
      </span>
    </>
  );

  return (
    <div>
      {expandable ? (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-hover focus-visible:-outline-offset-2"
        >
          {head}
        </button>
      ) : (
        <div className="flex items-start gap-3 px-4 py-3">{head}</div>
      )}
      {open && (
        <div className="space-y-3 px-4 pb-4 pl-11">
          {result.newFailures && result.newFailures.length > 0 && <Lines title="New on this branch" lines={result.newFailures} danger />}
          {result.details && result.details.length > 0 && <Lines title="Found" lines={result.details} />}
          {result.command && (
            <p className="font-mono text-xs text-fg-subtle">
              $ {result.command}
              {result.exitCode !== undefined && result.exitCode !== 0 && <span> · exit {result.exitCode}</span>}
            </p>
          )}
          {result.outputTail && <ToolOutput label="Output" text={result.outputTail} error={result.status === "fail"} startAtEnd />}
        </div>
      )}
    </div>
  );
}

function Lines({ title, lines, danger = false }: { title: string; lines: string[]; danger?: boolean }) {
  return (
    <div>
      <div className={clsx("mb-1 text-2xs font-medium tracking-wide uppercase", danger ? "text-danger" : "text-fg-subtle")}>{title}</div>
      <ul className="space-y-0.5 font-mono text-xs leading-relaxed text-fg-muted [overflow-wrap:anywhere]">
        {lines.map((line, index) => (
          <li key={index}>{line}</li>
        ))}
      </ul>
    </div>
  );
}
