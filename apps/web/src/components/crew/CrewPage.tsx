import { useMemo } from "react";
import clsx from "clsx";
import { LoaderCircle, Lock, Plus } from "lucide-react";
import { agentIsland, agentTagline, islandImage, islandName } from "@shared/islands";
import type { Agent, Brain, ComputerSummary, Device, ModelOption } from "@shared/types";
import { brainName, brainsFor } from "../../lib/brains";
import { computerTone } from "../../lib/computer";
import { conversationTitle } from "../../lib/conversations";
import { modelLabel } from "../../lib/models";
import { useDevices } from "../../lib/remote";
import { useResolvedTheme } from "../../lib/theme";
import { selectAgent, selectAgentWorking, setNewAgentDialogOpen, useStore } from "../../store";
import { Mascot } from "../mascot";
import { ProviderMark } from "../ProviderMark";
import { Button } from "../ui/Button";
import { Skeleton } from "../ui/Skeleton";
import { StatusDot } from "../ui/StatusDot";

/**
 * Your crew: every agent as a row, like the landing page's crew — its island with its mascot on it, its name and
 * tagline, what it's doing, then its computer, its brains and its model. A row opens that agent.
 */

/** Agent, then computer, brains and model; on phones the last three wrap under the agent. */
const COLUMNS = "md:grid-cols-[minmax(0,1fr)_9rem_13rem_9rem]";
/** At most this many brain chips; the rest are a "+N". */
const MAX_BRAINS = 3;

export function CrewPage() {
  const agents = useStore((s) => s.agents);
  const agentsState = useStore((s) => s.agentsState);
  const devices = useDevices((s) => s.status?.devices);
  // This device's agents first, then each paired device's (as in the rail).
  const ordered = useMemo(() => [...agents.filter((a) => !a.deviceId), ...agents.filter((a) => a.deviceId)], [agents]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-5xl px-4 pt-20 pb-12 sm:px-6 md:pt-24">
        <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
          <div className="min-w-0">
            <h1 className="text-title text-fg-strong">Your crew</h1>
            <p className="mt-1 text-sm text-fg-muted">
              Each agent works from its own island: a computer of its own, the brains you attach to it and a model to think with.
            </p>
          </div>
          <Button size="sm" onClick={() => setNewAgentDialogOpen(true)}>
            <Plus /> New agent
          </Button>
        </header>

        <div className="mt-8 overflow-hidden rounded-2xl border border-hairline bg-panel">
          <div className={`hidden h-9 items-center gap-x-6 border-b border-hairline px-4 text-2xs font-medium text-fg-subtle md:grid ${COLUMNS}`}>
            <span>Agent</span>
            <span>Computer</span>
            <span>Knowledge</span>
            <span>Model</span>
          </div>
          {agentsState === "loading" && !agents.length ? (
            <ul aria-busy="true" aria-label="Loading your crew">
              {[0, 1, 2].map((key) => (
                <li key={key} className="flex items-center gap-4 border-t border-hairline px-4 py-3.5 first:border-t-0">
                  <Skeleton className="h-14 w-21 rounded-lg" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-3.5 w-40 rounded" />
                    <Skeleton className="h-3 w-64 rounded" />
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <ul>
              {ordered.map((agent) => (
                <li key={agent.id} className="border-t border-hairline first:border-t-0">
                  <CrewRow agent={agent} device={devices?.find((d) => d.id === agent.deviceId)} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function CrewRow({ agent, device }: { agent: Agent; device: Device | undefined }) {
  // The islands at night in dark mode, at sunrise in light mode, like the scene on Home.
  const dawn = useResolvedTheme() === "light";
  const island = agentIsland(agent);
  const offline = Boolean(device && !device.online);
  const working = useStore((s) => selectAgentWorking(s, agent.id));
  const asleep = !working && (offline || agent.computer?.state === "stopped");
  const description = agent.instructions.split("\n").find((line) => line.trim())?.trim();

  return (
    <button
      type="button"
      onClick={() => selectAgent(agent.id)}
      className={`flex w-full flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3.5 text-left transition-colors hover:bg-hover active:bg-selected focus-visible:-outline-offset-2 md:grid ${COLUMNS}`}
    >
      <div className="flex w-full min-w-0 items-center gap-4 md:w-auto">
        <div className={clsx("relative shrink-0", offline && "opacity-50 grayscale")}>
          <img
            src={islandImage(island, dawn)}
            alt={`${islandName(island)} island`}
            width={84}
            height={56}
            loading="lazy"
            className="h-14 w-21 rounded-lg object-cover ring-1 ring-hairline"
          />
          <span className="absolute -right-2 -bottom-2 grid size-7 place-items-center rounded-full border border-hairline bg-panel">
            <Mascot spec={agent.mascot} size={20} state={working ? "working" : asleep ? "sleeping" : "idle"} title={agent.name} />
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm">
            <span className="font-medium text-fg">{agent.name}</span>
            <span className="text-fg-subtle"> · {agentTagline(agent)}</span>
            {device && <span className="text-fg-subtle"> · on {device.name}</span>}
          </p>
          {description && <p className="truncate text-xs text-fg-muted">{description}</p>}
          <Now agent={agent} working={working} offline={offline} />
        </div>
      </div>

      {/* Phones: under the agent, lined up with its text. */}
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 max-md:pl-25 md:contents">
        <Computer computer={agent.computer} />
        <Brains agent={agent} />
        <Model agent={agent} />
      </div>
    </button>
  );
}

/** What the agent is doing right now: the chat it's working in, a paused queue, or what's in its workspace. */
function Now({ agent, working, offline }: { agent: Agent; working: boolean; offline: boolean }) {
  const chat = useStore((s) => {
    if (!working) return null;
    const running = s.conversations.filter((c) => c.agentId === agent.id && c.id in s.activeRuns);
    return running[0] ? conversationTitle(running[0]) : null;
  });
  if (working)
    return (
      <p className="mt-1 flex items-center gap-1.5 font-mono text-2xs text-fg-subtle">
        <LoaderCircle className="size-3 shrink-0 animate-spin text-accent" />
        <span className="truncate">{chat ?? "working"}</span>
      </p>
    );
  if (agent.queueHold)
    return (
      <p className="mt-1 flex items-center gap-1.5 text-2xs text-warning">
        <StatusDot tone="amber" />
        <span className="truncate">Tasks paused: {agent.queueHold.reason}</span>
      </p>
    );
  const { chats, pages, routines } = agent.counts;
  const parts = [plural(chats, "chat"), pages ? plural(pages, "page") : null, routines ? plural(routines, "routine") : null].filter(Boolean);
  return (
    <p className="mt-1 truncate text-2xs text-fg-subtle tabular-nums">
      {offline ? "Offline" : "Idle"} · {parts.join(" · ")}
    </p>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const STATE_LABELS: Record<ComputerSummary["state"], string> = {
  running: "Running",
  starting: "Starting",
  stopping: "Going to sleep",
  stopped: "Asleep",
  error: "Error",
};

/** Its computer's state and size ("4 vCPU · 8 GB"); TOT doesn't measure CPU load, so there's no sparkline. */
function Computer({ computer }: { computer: ComputerSummary | null }) {
  const mode = useStore((s) => s.settings?.computer.mode);
  if (mode === "off" && !computer)
    return (
      <div className="flex flex-col gap-1">
        <span className="flex items-center gap-1.5 text-xs text-fg-muted">
          <StatusDot tone="gray" /> Off
        </span>
        <span className="text-2xs text-fg-subtle max-md:hidden">Computers are off</span>
      </div>
    );
  if (!computer)
    return (
      <div className="flex flex-col gap-1">
        <span className="flex items-center gap-1.5 text-xs text-fg-muted">
          <StatusDot tone="gray" /> Not started
        </span>
        <span className="text-2xs text-fg-subtle max-md:hidden">Starts with its first job</span>
      </div>
    );
  const { tone, pulse } = computerTone(computer.state);
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="flex items-center gap-1.5 text-xs text-fg-muted">
        <StatusDot tone={tone} pulse={pulse} /> {STATE_LABELS[computer.state]}
      </span>
      <span className="truncate text-2xs text-fg-subtle tabular-nums max-md:hidden" title={computer.error ?? computer.label}>
        {computerSize(computer)}
      </span>
    </div>
  );
}

/** "Boat VM · 4 vCPU / 8 GB" → "4 vCPU · 8 GB"; "Local workspace (sandboxed)" → "Local workspace". */
function computerSize(computer: ComputerSummary): string {
  if (computer.kind === "local") return "On this Mac";
  const size = computer.label.includes("·") ? computer.label.slice(computer.label.indexOf("·") + 1).trim() : computer.label;
  return size.replace(" / ", " · ");
}

function Brains({ agent }: { agent: Agent }) {
  const all = useStore((s) => (agent.deviceId ? s.deviceBrains[agent.deviceId] : s.brains));
  const agents = useStore((s) => s.agents);
  const mine = useMemo(() => (all ? brainsFor(all, agent.id).mine : []), [all, agent.id]);
  if (!all) return <Skeleton className="h-5 w-24 rounded-full" />;
  if (!mine.length) return <span className="text-xs text-fg-subtle">None</span>;
  const shown = mine.slice(0, MAX_BRAINS);
  return (
    <div className="flex min-w-0 flex-wrap gap-1">
      {shown.map((brain) => (
        <BrainChip key={brain.id} brain={brain} name={brainName(brain, agents, agent.id)} readOnly={isReadOnly(brain, agent.id)} />
      ))}
      {mine.length > shown.length && (
        <span
          title={mine
            .slice(MAX_BRAINS)
            .map((brain) => brainName(brain, agents, agent.id))
            .join(", ")}
          className="inline-flex items-center rounded-full border border-edge px-2 py-0.5 text-2xs text-fg-subtle tabular-nums"
        >
          +{mine.length - shown.length}
        </span>
      )}
    </div>
  );
}

const isReadOnly = (brain: Brain, agentId: string) =>
  !brain.ownerAgentId && !brain.allAgents && brain.agents.find((a) => a.agentId === agentId)?.access === "read";

function BrainChip({ brain, name, readOnly }: { brain: Brain; name: string; readOnly: boolean }) {
  return (
    <span
      title={readOnly ? `${name} · read-only for this agent` : brain.description || name}
      className="inline-flex max-w-full items-center gap-1 rounded-full border border-edge px-2 py-0.5 text-2xs whitespace-nowrap text-fg-muted"
    >
      {readOnly && <Lock aria-label="read-only" className="size-2.5 shrink-0" />}
      <span className="truncate">{name}</span>
    </span>
  );
}

function Model({ agent }: { agent: Agent }) {
  const models = useStore((s) => (agent.deviceId ? (s.deviceModels[agent.deviceId] ?? s.models) : s.models));
  const provider = providerOf(models, agent.modelId);
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs text-fg-muted">
      {provider && <ProviderMark provider={provider} className="size-3.5 shrink-0" />}
      <span className="truncate">{modelLabel(models, agent.modelId)}</span>
    </span>
  );
}

/** "claude" for "claude:claude-opus-5-5"; none for Auto. */
function providerOf(models: ModelOption[], modelId: string): "claude" | "chatgpt" | null {
  const provider = models.find((m) => m.id === modelId)?.provider ?? modelId.split(":")[0];
  return provider === "claude" || provider === "chatgpt" ? provider : null;
}
