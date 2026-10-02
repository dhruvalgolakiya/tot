import { useState, type FormEvent, type ReactNode } from "react";
import { DropdownMenu } from "radix-ui";
import { Ellipsis, LoaderCircle, Unplug, X } from "lucide-react";
import type { SlackPatch, SlackStatus } from "@shared/types";
import { api, errorMessage } from "../../lib/api";
import { useCopy } from "../../hooks/useCopy";
import { notifyError, setSlackStatus, useStore } from "../../store";
import { ConfirmDialog } from "../ConfirmDialog";
import { Button } from "../ui/Button";
import { Callout } from "../ui/Callout";
import { cardClass } from "../ui/Card";
import { Field } from "../ui/Field";
import { IconButton } from "../ui/IconButton";
import { SecretInput } from "../ui/SecretInput";
import { Skeleton } from "../ui/Skeleton";
import { StatusDot } from "../ui/StatusDot";
import { Tip } from "../ui/Tip";

/**
 * TOT's own Slack bot (Socket Mode, no public URL needed). DM it or @mention
 * it and an agent works the request, with the thread so far as context; the
 * answer posts back in the thread and approvals become buttons there. Only
 * people the user allows can use it; others show up as requests.
 */
export function SlackSettings() {
  const slack = useStore((s) => s.slack);

  if (!slack) {
    return (
      <div aria-busy="true" aria-label="Loading Slack status">
        <Skeleton className="h-28 w-full rounded-xl" />
      </div>
    );
  }

  return (
    <div className={cardClass()}>
      {slack.state === "connecting" && (
        <div className="flex items-center gap-2 text-sm text-fg-muted">
          <LoaderCircle className="size-4 animate-spin text-accent" />
          Connecting to Slack…
        </div>
      )}
      {slack.state === "connected" && <ConnectedView status={slack} />}
      {(slack.state === "not-set-up" || slack.state === "error") && <SetupGuide status={slack} />}
    </div>
  );
}

function StepBadge({ children }: { children: ReactNode }) {
  return (
    <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-fill text-2xs font-medium text-fg-muted">
      {children}
    </span>
  );
}

/** Not connected (or a connection attempt failed): the 4-step setup guide. */
function SetupGuide({ status }: { status: SlackStatus }) {
  const { copied, copy } = useCopy();
  const [appToken, setAppToken] = useState("");
  const [botToken, setBotToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect(event: FormEvent) {
    event.preventDefault();
    const app = appToken.trim();
    const bot = botToken.trim();
    if (!app || !bot || busy) return;
    setBusy(true);
    setError(null);
    try {
      setSlackStatus(await api.setSlackTokens({ appToken: app, botToken: bot }));
      setAppToken("");
      setBotToken("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {status.state === "error" && status.error && <Callout tone="danger">{status.error}</Callout>}

      <ol className="space-y-4">
        <li className="flex gap-3">
          <StepBadge>1</StepBadge>
          <div className="flex-1 space-y-2">
            <p className="text-sm text-fg-muted">Create a Slack app from TOT's manifest.</p>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
              <Button
                variant="primary"
                size="sm"
                onClick={() => window.open(status.createAppUrl, "_blank", "noopener,noreferrer")}
              >
                Create the Slack app
              </Button>
              <button type="button" onClick={() => void copy(status.manifest)} className="link-muted text-xs">
                {copied ? "Copied" : "Copy manifest"}
              </button>
            </div>
          </div>
        </li>

        <li className="flex gap-3">
          <StepBadge>2</StepBadge>
          <p className="flex-1 text-sm text-fg-muted">
            In the app's <strong className="font-medium text-fg">Basic Information</strong>, create an App-Level Token
            with the <code className="rounded bg-fill px-1 py-0.5 text-xs">connections:write</code> scope.
          </p>
        </li>

        <li className="flex gap-3">
          <StepBadge>3</StepBadge>
          <p className="flex-1 text-sm text-fg-muted">
            <strong className="font-medium text-fg">Install to Workspace</strong>, then copy the Bot User OAuth Token.
          </p>
        </li>

        <li className="flex gap-3">
          <StepBadge>4</StepBadge>
          <form onSubmit={(event) => void connect(event)} className="flex-1 space-y-3">
            <Field label="App-level token" htmlFor="slack-app-token">
              <SecretInput
                id="slack-app-token"
                value={appToken}
                onChange={(value) => {
                  setAppToken(value);
                  setError(null);
                }}
                saved={false}
                cleared={false}
                onClearedChange={() => {}}
                placeholder="xapp-…"
              />
            </Field>
            <Field label="Bot token" htmlFor="slack-bot-token">
              <SecretInput
                id="slack-bot-token"
                value={botToken}
                onChange={(value) => {
                  setBotToken(value);
                  setError(null);
                }}
                saved={false}
                cleared={false}
                onClearedChange={() => {}}
                placeholder="xoxb-…"
              />
            </Field>
            {error && <Callout tone="danger">{error}</Callout>}
            <Button type="submit" variant="primary" size="sm" disabled={!appToken.trim() || !botToken.trim() || busy}>
              {busy ? "Connecting…" : "Connect"}
            </Button>
          </form>
        </li>
      </ol>
    </div>
  );
}

/** Connected: who it's connected as, default agent, allowed people, and pending requests. */
function ConnectedView({ status }: { status: SlackStatus }) {
  const agents = useStore((s) => s.agents);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [agentSaving, setAgentSaving] = useState(false);
  const [busyPersonId, setBusyPersonId] = useState<string | null>(null);

  const firstAgentId = agents[0]?.id ?? null;
  const selectedAgentId = status.defaultAgentId ?? firstAgentId ?? "";

  async function patch(body: SlackPatch) {
    try {
      setSlackStatus(await api.patchSlack(body));
    } catch (error) {
      notifyError(error);
    }
  }

  async function setDefaultAgent(agentId: string) {
    setAgentSaving(true);
    await patch({ defaultAgentId: agentId === firstAgentId ? null : agentId });
    setAgentSaving(false);
  }

  async function allow(id: string) {
    setBusyPersonId(id);
    await patch({ allow: id });
    setBusyPersonId(null);
  }

  async function disallow(id: string) {
    setBusyPersonId(id);
    await patch({ disallow: id });
    setBusyPersonId(null);
  }

  async function disconnect() {
    try {
      setSlackStatus(await api.disconnectSlack());
    } catch (error) {
      notifyError(error);
    }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm text-fg">
          <StatusDot tone="green" />
          Connected to {status.workspace} as @{status.botName}
        </div>
        <DropdownMenu.Root modal={false}>
          <DropdownMenu.Trigger asChild>
            <IconButton label="More Slack options" size="sm">
              <Ellipsis />
            </IconButton>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="end" sideOffset={4} className="menu w-44">
              <DropdownMenu.Item className="menu-item menu-item-danger" onSelect={() => setConfirmOpen(true)}>
                <Unplug className="size-4" /> Disconnect
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>

      {agents.length > 0 && (
        <Field
          label="Default agent"
          htmlFor="slack-default-agent"
          hint="Answers when a message doesn't start with an agent's name."
        >
          <select
            id="slack-default-agent"
            value={selectedAgentId}
            onChange={(event) => void setDefaultAgent(event.target.value)}
            disabled={agentSaving}
            className="input h-10 rounded-xl bg-elevated"
          >
            {agents.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
                {agent.id === firstAgentId ? " (default)" : ""}
              </option>
            ))}
          </select>
        </Field>
      )}

      <div>
        <h3 className="group-label mb-2">People who can use TOT</h3>
        {status.allowedUsers.length === 0 ? (
          <p className="text-sm text-fg-subtle">Nobody yet — when someone messages the bot, they'll show up here to allow.</p>
        ) : (
          <ul className="space-y-px">
            {status.allowedUsers.map((person) => (
              <li key={person.id} className="group flex h-9 items-center justify-between gap-2 rounded-lg px-2.5 hover:bg-hover">
                <span className="min-w-0 flex-1 truncate text-sm text-fg">{person.name}</span>
                <Tip content="Remove">
                  <IconButton
                    label={`Remove ${person.name}`}
                    size="sm"
                    onClick={() => void disallow(person.id)}
                    disabled={busyPersonId === person.id}
                    className="opacity-0 transition-opacity group-hover:opacity-100 pointer-coarse:opacity-100"
                  >
                    <X />
                  </IconButton>
                </Tip>
              </li>
            ))}
          </ul>
        )}
      </div>

      {status.requests.length > 0 && (
        <div>
          <h3 className="group-label mb-2">Requests</h3>
          <ul className="space-y-1.5">
            {status.requests.map((person) => (
              <li key={person.id} className="flex items-center justify-between gap-3 rounded-lg bg-fill-subtle px-3 py-2">
                <span className="min-w-0 flex-1 truncate text-sm text-fg">{person.name}</span>
                <Button size="sm" variant="secondary" onClick={() => void allow(person.id)} disabled={busyPersonId === person.id}>
                  Allow
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="border-t border-hairline pt-3 text-xs leading-relaxed text-fg-subtle">
        DM the bot, or @mention it in a channel. Start with an agent's name to pick one, e.g. “Puddin: summarize this thread”.
      </p>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Disconnect Slack?"
        description="The bot stops answering in Slack. Chats it started stay in TOT."
        confirmLabel="Disconnect"
        onConfirm={() => void disconnect()}
      />
    </div>
  );
}
