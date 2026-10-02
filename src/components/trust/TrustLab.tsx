import { useEffect, useState, type FormEvent } from "react";
import type { GateReport } from "@shared/types";
import { errorMessage } from "../../lib/api";
import { useStore } from "../../store";
import { Button } from "../ui/Button";
import { Callout } from "../ui/Callout";
import { Field } from "../ui/Field";
import { PageHeader } from "../ui/SectionHeader";
import { Select } from "../ui/Select";
import { GateReportView } from "./GateReportView";
import { SAMPLE_REPORT } from "./samples";
import { trustApi } from "./trustApi";

/**
 * Dev page (/dev/trust) until tasks exist: run the gates on any repo folder on an agent's
 * computer, or load samples, so the components that tasks will show can be built and checked now.
 */
export function TrustLab() {
  const agents = useStore((s) => s.agents);
  const [agentId, setAgentId] = useState("");
  const [cwd, setCwd] = useState("repos/shop");
  const [baseRef, setBaseRef] = useState("main");
  const [plan, setPlan] = useState("");
  const [report, setReport] = useState<GateReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!agentId && agents[0]) setAgentId(agents[0].id);
  }, [agents, agentId]);

  async function check(event: FormEvent) {
    event.preventDefault();
    setChecking(true);
    setError(null);
    try {
      setReport(await trustApi.check({ agentId, cwd, baseRef, plan: plan.trim() || undefined }));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setChecking(false);
    }
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-8 px-4 py-8 sm:px-6">
        <PageHeader
          title="Checks lab"
          description="Dev only, until tasks land: run the repo's checks on any folder on an agent's computer."
          action={
            <Button size="sm" variant="ghost" onClick={() => setReport({ ...SAMPLE_REPORT, at: Date.now() })}>
              Load samples
            </Button>
          }
        />

        <form onSubmit={check} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Field label="Agent" htmlFor="lab-agent">
              <Select
                id="lab-agent"
                aria-label="Agent"
                value={agentId}
                onValueChange={setAgentId}
                options={agents.map((agent) => ({ value: agent.id, label: agent.name }))}
                className="rounded-xl"
              />
            </Field>
            <Field label="Repo folder" htmlFor="lab-cwd">
              <input id="lab-cwd" value={cwd} onChange={(e) => setCwd(e.target.value)} spellCheck={false} className="input rounded-xl font-mono" />
            </Field>
            <Field label="Base" htmlFor="lab-base">
              <input id="lab-base" value={baseRef} onChange={(e) => setBaseRef(e.target.value)} spellCheck={false} className="input rounded-xl font-mono" />
            </Field>
          </div>
          <Field label="Plan" htmlFor="lab-plan" hint="Optional. The paths it cites are the files the work may change.">
            <textarea
              id="lab-plan"
              value={plan}
              onChange={(e) => setPlan(e.target.value)}
              rows={3}
              placeholder="e.g. Fix the empty-cart crash in src/checkout.js:4 and add a test in test/checkout.test.js"
              className="input resize-y rounded-xl"
            />
          </Field>
          <Button type="submit" variant="primary" disabled={checking || !agentId || !cwd.trim() || !baseRef.trim()}>
            {checking ? "Running checks…" : "Run checks"}
          </Button>
        </form>

        {error && <Callout tone="danger">{error}</Callout>}
        {report && <GateReportView report={report} baseRef={baseRef} />}
      </div>
    </div>
  );
}
