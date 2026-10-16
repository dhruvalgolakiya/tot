import type { Review, ReviewFinding } from "@tot/shared/types";
import { modelLabel, PROVIDER_LABELS } from "../../lib/models";
import { useStore } from "../../store";
import { Badge } from "../ui/Badge";
import { Card } from "../ui/Card";
import { TickText } from "../ui/TickText";

const GROUPS: { severity: ReviewFinding["severity"]; title: string }[] = [
  { severity: "must-fix", title: "Must fix" },
  { severity: "should-fix", title: "Should fix" },
  { severity: "nit", title: "Nits" },
];

/** An independent review: the verdict, who reviewed, the summary, and findings grouped by severity with file:line. */
export function ReviewView({ review }: { review: Review }) {
  const models = useStore((s) => s.models);
  const approved = review.verdict === "approve";
  const { provider, model } = review.reviewer;

  return (
    <section aria-label="Review" className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Badge tone={approved ? "success" : "danger"} dot>
          {approved ? "Approved" : "Changes requested"}
        </Badge>
        <span className="text-xs text-fg-subtle">
          Reviewed by {PROVIDER_LABELS[provider]} · {modelLabel(models, `${provider}:${model}`)}, in a fresh session
        </span>
      </div>
      <p className="text-sm leading-relaxed text-fg-muted">
        <TickText text={review.summary} />
      </p>

      {review.findings.length === 0 ? (
        <p className="text-xs text-fg-subtle">No findings.</p>
      ) : (
        GROUPS.map(({ severity, title }) => {
          const findings = review.findings.filter((finding) => finding.severity === severity);
          if (!findings.length) return null;
          return (
            <div key={severity} className="space-y-2">
              <h3 className="group-label flex items-center gap-2">
                {title}
                <span className="tabular-nums">{findings.length}</span>
              </h3>
              <Card padding="none" className="divide-y divide-hairline">
                {findings.map((finding, index) => (
                  <div key={index} className="space-y-1 px-4 py-3">
                    <p className="font-mono text-xs text-fg-subtle [overflow-wrap:anywhere]">
                      {finding.file}
                      {finding.line ? `:${finding.line}` : ""}
                    </p>
                    <p className="text-sm text-fg">
                      <TickText text={finding.issue} />
                    </p>
                    {finding.suggestion && (
                      <p className="text-xs leading-relaxed text-fg-muted">
                        <TickText text={finding.suggestion} />
                      </p>
                    )}
                  </div>
                ))}
              </Card>
            </div>
          );
        })
      )}
    </section>
  );
}
