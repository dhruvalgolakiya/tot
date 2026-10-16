import { useState } from "react";
import { Check, Copy, ExternalLink, MonitorPlay, Power } from "lucide-react";
import type { ComputerSummary, MascotSpec } from "@shared/types";
import { useCopy } from "../hooks/useCopy";
import { COMPUTER_KIND_LABELS, computerTone } from "../lib/computer";
import { relativeTime } from "../lib/format";
import { stopAgentComputer } from "../store";
import { Mascot } from "./mascot";
import { Badge } from "./ui/Badge";
import { Button } from "./ui/Button";
import { buttonClass } from "./ui/buttonStyles";
import { Callout } from "./ui/Callout";
import { cardClass } from "./ui/Card";
import { IconButton } from "./ui/IconButton";
import { StatusDot } from "./ui/StatusDot";

type ComputerDetailsProps = {
  agentId: string;
  agentName: string;
  mascot: MascotSpec;
  computer: ComputerSummary;
};

/** State, controls, exposed URLs and workspace of an agent's shared computer. */
export function ComputerDetails({ agentId, agentName, mascot, computer }: ComputerDetailsProps) {
  const [stopping, setStopping] = useState(false);
  const { copied, copy } = useCopy();
  const { tone, pulse } = computerTone(computer.state);
  const canStop = computer.state === "running" || computer.state === "starting";
  const stopped = computer.state === "stopped";

  async function stop() {
    setStopping(true);
    await stopAgentComputer(agentId);
    setStopping(false);
  }

  return (
    <div className="space-y-5">
      <section className={cardClass()}>
        <div className="flex items-center gap-2">
          {stopped ? (
            <Mascot spec={mascot} size={20} state="sleeping" title={agentName} />
          ) : (
            <StatusDot tone={tone} pulse={pulse} />
          )}
          <span className="text-sm font-medium text-fg capitalize">{computer.state}</span>
          <Badge className="ml-auto">{COMPUTER_KIND_LABELS[computer.kind] ?? computer.kind}</Badge>
        </div>
        <p className="mt-2 text-sm text-fg-muted">{computer.label}</p>
        {computer.lastUsedAt !== undefined && (
          <p className="mt-0.5 text-xs text-fg-subtle">Last used {relativeTime(computer.lastUsedAt)}</p>
        )}
        {computer.error && (
          <Callout tone="danger" className="mt-3">
            {computer.error}
          </Callout>
        )}
        <div className="mt-4 flex flex-wrap gap-2">
          {computer.desktopUrl && (
            // A TOT route that redirects to a fresh desktop stream: always open it, never cache it.
            <a href={computer.desktopUrl} target="_blank" rel="noopener noreferrer" className={buttonClass("primary", "sm")}>
              <MonitorPlay /> Open desktop
            </a>
          )}
          {canStop || stopping || computer.state === "stopping" ? (
            <Button size="sm" onClick={() => void stop()} disabled={!canStop || stopping}>
              <Power /> {stopping || computer.state === "stopping" ? "Stopping…" : "Stop computer"}
            </Button>
          ) : (
            <p className="text-xs text-fg-subtle">Wakes up automatically the next time it's needed.</p>
          )}
        </div>
      </section>

      {computer.gui && computer.screenshotUrl && (
        <section>
          <h3 className="group-label mb-2">Screen</h3>
          <div className={cardClass({ padding: "none", className: "overflow-hidden bg-sunken" })}>
            <img
              key={computer.screenshotUrl}
              src={computer.screenshotUrl}
              alt={`${agentName}'s computer screen`}
              className="w-full object-contain"
            />
          </div>
        </section>
      )}

      {computer.exposedUrls.length > 0 && (
        <section>
          <h3 className="group-label mb-2">Exposed ports</h3>
          <ul className="space-y-1.5">
            {computer.exposedUrls.map(({ port, url }) => (
              <li key={`${port}-${url}`}>
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={cardClass({ interactive: true, padding: "sm", className: "flex items-center gap-2 text-ui" })}
                >
                  <Badge className="font-mono">:{port}</Badge>
                  <span className="min-w-0 flex-1 truncate text-accent-text">{url}</span>
                  <ExternalLink className="size-3.5 shrink-0 text-fg-subtle" />
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}

      {computer.workspacePath && (
        <section>
          <h3 className="group-label mb-2">Workspace</h3>
          <div className="flex items-center gap-1 rounded-lg border border-hairline bg-sunken py-1 pr-1 pl-3">
            <span className="min-w-0 flex-1 truncate font-mono text-ui text-fg-muted" title={computer.workspacePath}>
              {computer.workspacePath}
            </span>
            <IconButton label="Copy path" size="sm" onClick={() => void copy(computer.workspacePath ?? "")}>
              {copied ? <Check /> : <Copy />}
            </IconButton>
          </div>
        </section>
      )}
    </div>
  );
}
