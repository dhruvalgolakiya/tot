import { CircleCheck, Clock, FolderGit2, GitBranch, LoaderCircle } from "lucide-react";
import { Ledger, LedgerRow, LedgerSection } from "../../web/src/components/home/Ledger";
import { Mascot } from "../../web/src/components/mascot";
import { StatusDot } from "../../web/src/components/ui/StatusDot";
import { crew, type CrewMember } from "../crew";
import { elapsed, useTicker } from "./ticker";

/** Home's ledger as the app shows it, filled in by the crew. The working rows tick and move on to their next step. */

export function Face({ who, working = false, size = 18 }: { who: CrewMember; working?: boolean; size?: number }) {
  return <Mascot spec={crew[who].spec} size={size} state={working ? "working" : "idle"} title={crew[who].name} />;
}

export const WORKING: { who: CrewMember; title: string; startedAt: number; steps: string[] }[] = [
  { who: "bolt", title: "Add a CSV export for orders", startedAt: 421, steps: ["writing src/orders/export.ts", "npm test -- orders", "opening a draft PR"] },
  {
    who: "nimbus",
    title: "Compare open-source vector databases",
    startedAt: 58,
    steps: ["reading source 3 of 12", "benchmarking on its computer", "saving notes to the research brain"],
  },
  { who: "tot", title: "Tune the judge prompt", startedAt: 133, steps: ["pnpm test --filter judge", "reading evals/judge.md", "grading 40 answers again"] },
];

const check = <CircleCheck aria-label="Checks passing" className="size-3.5 text-success" />;

export function DemoLedger() {
  const seconds = useTicker();
  return (
    <Ledger>
      <LedgerSection label="Needs you" count={1} tone="warning">
        <LedgerRow leading={<StatusDot tone="amber" />} title="Dark logo for transactional emails" detail="Use the new purple, or keep it black?" trailing={<Face who="mochi" />} />
      </LedgerSection>
      <LedgerSection label="Working" count={WORKING.length}>
        {WORKING.map((task, index) => (
          <LedgerRow
            key={task.title}
            leading={<LoaderCircle className="size-3.5 animate-spin text-accent" />}
            title={task.title}
            // Each task moves on to its next step every few seconds, out of step with the others.
            detail={task.steps[Math.floor((seconds + index * 2) / 5) % task.steps.length]}
            mono
            trailing={
              <>
                <Face who={task.who} working />
                {elapsed(task.startedAt + seconds)}
              </>
            }
          />
        ))}
      </LedgerSection>
      <LedgerSection label="Ready to land" count={2}>
        <LedgerRow
          leading={<GitBranch className="size-3.5 text-fg-subtle" />}
          title="Retry checkout webhooks with backoff"
          detail="+84 −12 · 3 files"
          trailing={
            <>
              {check}
              <Face who="bolt" />
            </>
          }
        />
        <LedgerRow
          leading={<GitBranch className="size-3.5 text-fg-subtle" />}
          title="Fix the flaky checkout e2e test"
          detail="+9 −31 · 2 files"
          trailing={
            <>
              {check}
              <Face who="tot" />
            </>
          }
        />
      </LedgerSection>
      <LedgerSection label="Coming up" count={2}>
        <LedgerRow leading={<Clock className="size-3.5 text-fg-subtle" />} title="Inbox triage" detail="Every 2 hours" trailing="in 41m" />
        <LedgerRow leading={<Clock className="size-3.5 text-fg-subtle" />} title="Morning AI news" detail="Every weekday at 09:00" trailing="in 14h" />
      </LedgerSection>
      <LedgerSection label="Projects" count={2}>
        <LedgerRow
          leading={<FolderGit2 className="size-4 text-fg-muted" />}
          title="shop"
          detail="1 needs you · 2 working · 2 ready to land"
          trailing={
            <>
              <StatusDot tone="amber" />
              now
            </>
          }
        />
        <LedgerRow
          leading={<FolderGit2 className="size-4 text-fg-muted" />}
          title="evals"
          detail="1 working"
          trailing={
            <>
              <StatusDot tone="green" pulse />
              2m
            </>
          }
        />
      </LedgerSection>
    </Ledger>
  );
}
