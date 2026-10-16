import { useEffect, useRef, useState, type FormEvent } from "react";
import clsx from "clsx";
import { DropdownMenu } from "radix-ui";
import { Check, ChevronDown, Copy, Ellipsis, ExternalLink, Unplug } from "lucide-react";
import type { GitHubDeviceStart } from "@shared/types";
import { api, errorMessage } from "../../lib/api";
import { useCopy } from "../../hooks/useCopy";
import { notifyError, setGithubStatus, useStore } from "../../store";
import { ConfirmDialog } from "../ConfirmDialog";
import { Button } from "../ui/Button";
import { buttonClass } from "../ui/buttonStyles";
import { Callout } from "../ui/Callout";
import { Field } from "../ui/Field";
import { IconButton } from "../ui/IconButton";
import { LedgerField, LedgerGroup, LedgerHeader } from "../ui/Ledger";
import { SecretInput } from "../ui/SecretInput";
import { Skeleton } from "../ui/Skeleton";
import { Switch } from "../ui/Switch";
import { Tip } from "../ui/Tip";

const TOKEN_URL = "https://github.com/settings/tokens/new?scopes=repo,read:org,workflow&description=TOT";

const SOURCE_LABELS: Record<"cli" | "token" | "oauth", string> = {
  cli: "GitHub CLI login",
  token: "a token",
  oauth: "GitHub sign-in",
};

type ConnectMode = "idle" | "token" | "device";

/**
 * One GitHub account for the whole app: agents get GitHub's MCP tools (issues,
 * pull requests, code search) and their computers are logged in for git/gh.
 * Writes stay off until the user flips the switch below.
 */
export function GitHubSettings() {
  const github = useStore((s) => s.github);
  const [mode, setMode] = useState<ConnectMode>("idle");
  const [showOptions, setShowOptions] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tokenValue, setTokenValue] = useState("");
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [device, setDevice] = useState<GitHubDeviceStart | null>(null);
  const [deviceMessage, setDeviceMessage] = useState<string | null>(null);
  const [writesSaving, setWritesSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const pollTimer = useRef<number | undefined>(undefined);
  const { copied, copy } = useCopy();

  useEffect(() => () => window.clearInterval(pollTimer.current), []);

  function resetConnectUi() {
    window.clearInterval(pollTimer.current);
    setMode("idle");
    setShowOptions(false);
    setReconnecting(false);
    setTokenValue("");
    setTokenError(null);
    setDevice(null);
    setDeviceMessage(null);
  }

  async function connectCli() {
    setBusy(true);
    try {
      setGithubStatus(await api.connectGithub({ method: "cli" }));
      resetConnectUi();
    } catch (error) {
      notifyError(error);
    } finally {
      setBusy(false);
    }
  }

  async function submitToken(event: FormEvent) {
    event.preventDefault();
    const token = tokenValue.trim();
    if (!token || busy) return;
    setBusy(true);
    setTokenError(null);
    try {
      setGithubStatus(await api.connectGithub({ method: "token", token }));
      resetConnectUi();
    } catch (error) {
      setTokenError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function pollDevice() {
    try {
      const poll = await api.pollGithubDevice();
      if (poll.state === "pending") return;
      window.clearInterval(pollTimer.current);
      if (poll.state === "connected") {
        if (poll.status) setGithubStatus(poll.status);
        resetConnectUi();
        return;
      }
      setDevice(null);
      setDeviceMessage(
        poll.state === "expired" ? "That code expired." : poll.state === "denied" ? "Sign-in was declined." : "Something went wrong.",
      );
    } catch {
      // Transient hiccup; keep polling until the code expires on its own.
    }
  }

  async function startDevice() {
    setBusy(true);
    setDeviceMessage(null);
    try {
      const start = await api.startGithubDevice();
      setDevice(start);
      setMode("device");
      window.clearInterval(pollTimer.current);
      pollTimer.current = window.setInterval(() => void pollDevice(), start.intervalSeconds * 1000);
    } catch (error) {
      notifyError(error);
    } finally {
      setBusy(false);
    }
  }

  async function setWrites(allowWrites: boolean) {
    setWritesSaving(true);
    try {
      setGithubStatus(await api.setGithubWrites(allowWrites));
    } catch (error) {
      notifyError(error);
    } finally {
      setWritesSaving(false);
    }
  }

  async function disconnect() {
    try {
      setGithubStatus(await api.disconnectGithub());
    } catch (error) {
      notifyError(error);
    }
  }

  if (!github) {
    return (
      <div aria-busy="true" aria-label="Loading GitHub status">
        <Skeleton className="h-28 w-full rounded-xl" />
      </div>
    );
  }

  // Connected: avatar, who it's connected as, the writes switch, and Disconnect in the menu.
  if (github.connection && !reconnecting) {
    const { connection, problem, allowWrites } = github;
    return (
      <LedgerGroup
        header={
          <LedgerHeader
            title={
              <span className="flex items-center gap-2.5">
                <img src={connection.avatarUrl} alt="" className="size-6 shrink-0 rounded-full" />
                {connection.name ?? connection.login}
              </span>
            }
            meta={`@${connection.login} · Connected with ${SOURCE_LABELS[connection.source]}`}
            action={
              <DropdownMenu.Root modal={false}>
                <DropdownMenu.Trigger asChild>
                  <IconButton label="More GitHub options" size="sm">
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
            }
          />
        }
      >
        {problem && (
          <div className="px-4 py-3">
            <Callout
              tone="warning"
              action={
                <button type="button" onClick={() => setReconnecting(true)} className="link-muted">
                  Reconnect
                </button>
              }
            >
              {problem}
            </Callout>
          </div>
        )}

        <LedgerField
          htmlFor="github-allow-writes"
          title="Agents can push and open pull requests"
          description="Off: GitHub tools are read-only and pushes are blocked. On: agents work on branches and open pull requests when you ask; merging and pushing to the main branch stay off-limits unless you ask. For a hard read-only guarantee, connect a read-only token."
          control={
            <Switch
              id="github-allow-writes"
              checked={allowWrites}
              onCheckedChange={(checked) => void setWrites(checked)}
              disabled={writesSaving}
            />
          }
        />

        <ConfirmDialog
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          title="Disconnect GitHub?"
          description="Agents lose GitHub access and their computers are logged out of GitHub."
          confirmLabel="Disconnect"
          onConfirm={() => void disconnect()}
        />
      </LedgerGroup>
    );
  }

  // Not connected (or reconnecting after a problem): one primary action, the rest tucked away.
  const primary: "cli" | "oauth" | "token" = github.cli ? "cli" : github.oauthAvailable ? "oauth" : "token";
  const oauthIsOther = primary !== "oauth" && github.oauthAvailable;
  const tokenIsOther = primary !== "token";
  const hasOthers = oauthIsOther || tokenIsOther;

  return (
    <LedgerGroup body="fields">
      <div className="p-4">
        {mode === "token" && (
          <form onSubmit={(event) => void submitToken(event)} className="space-y-3">
            <Field
              label="Personal access token"
              htmlFor="github-token"
              hint={
                <>
                  <a href={TOKEN_URL} target="_blank" rel="noopener noreferrer" className="link">
                    Create a classic token
                  </a>{" "}
                  with these scopes, or paste a fine-grained token.
                </>
              }
            >
              <SecretInput
                id="github-token"
                value={tokenValue}
                onChange={(value) => {
                  setTokenValue(value);
                  setTokenError(null);
                }}
                saved={false}
                cleared={false}
                onClearedChange={() => {}}
                placeholder="ghp_… or github_pat_…"
              />
            </Field>
            {tokenError && <Callout tone="danger">{tokenError}</Callout>}
            <div className="flex items-center gap-2">
              <Button type="submit" variant="primary" size="sm" disabled={!tokenValue.trim() || busy}>
                {busy ? "Connecting…" : "Connect"}
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={resetConnectUi} disabled={busy}>
                Cancel
              </Button>
            </div>
          </form>
        )}

        {mode === "device" && (
          <div className="space-y-3">
            {device ? (
              <>
                <p className="text-xs text-fg-subtle">Enter this code at GitHub to connect your account:</p>
                <div className="flex items-center gap-2">
                  <span className="flex-1 rounded-xl border border-edge bg-fill-subtle px-3 py-2 text-center font-mono text-lg tracking-[0.3em] text-fg">
                    {device.userCode}
                  </span>
                  <Tip content={copied ? "Copied" : "Copy code"}>
                    <IconButton label="Copy code" onClick={() => void copy(device.userCode)}>
                      {copied ? <Check /> : <Copy />}
                    </IconButton>
                  </Tip>
                </div>
                <div className="flex items-center gap-2">
                  <a href={device.verificationUri} target="_blank" rel="noopener noreferrer" className={buttonClass("secondary", "sm")}>
                    <ExternalLink /> Open GitHub
                  </a>
                  <Button type="button" variant="ghost" size="sm" onClick={resetConnectUi}>
                    Cancel
                  </Button>
                </div>
                <p className="text-xs text-fg-subtle">Waiting for you to approve…</p>
              </>
            ) : (
              <>
                {deviceMessage && <Callout tone="warning">{deviceMessage}</Callout>}
                <div className="flex items-center gap-2">
                  <Button type="button" variant="secondary" size="sm" onClick={() => void startDevice()} disabled={busy}>
                    Try again
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={resetConnectUi}>
                    Cancel
                  </Button>
                </div>
              </>
            )}
          </div>
        )}

        {mode === "idle" && (
          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2.5">
              <div className="min-w-0 flex-1 basis-56">
                <p className="text-sm font-medium text-fg">Connect GitHub</p>
                <p className="mt-0.5 text-xs leading-relaxed text-fg-subtle">Agents act as you: issues, pull requests and private repos.</p>
              </div>
              {primary === "cli" && github.cli && (
                <Button variant="primary" size="sm" onClick={() => void connectCli()} disabled={busy}>
                  {busy ? "Connecting…" : `Connect as @${github.cli.login}`}
                </Button>
              )}
              {primary === "oauth" && (
                <Button variant="primary" size="sm" onClick={() => void startDevice()} disabled={busy}>
                  Sign in with GitHub
                </Button>
              )}
              {primary === "token" && (
                <Button variant="primary" size="sm" onClick={() => setMode("token")} disabled={busy}>
                  Use a token
                </Button>
              )}
              {reconnecting && (
                <Button type="button" variant="ghost" size="sm" onClick={resetConnectUi}>
                  Cancel
                </Button>
              )}
            </div>

            {hasOthers && (
              <div>
                <button type="button" onClick={() => setShowOptions((value) => !value)} className="link-muted flex items-center gap-1 text-xs">
                  <ChevronDown className={clsx("size-3.5 transition-transform", showOptions && "rotate-180")} />
                  Other ways to connect
                </button>
                {showOptions && (
                  <div className="mt-2 flex flex-col items-start gap-1.5 pl-5">
                    {oauthIsOther && (
                      <button type="button" onClick={() => void startDevice()} disabled={busy} className="link-muted text-xs">
                        Sign in with GitHub
                      </button>
                    )}
                    {tokenIsOther && (
                      <button type="button" onClick={() => setMode("token")} className="link-muted text-xs">
                        Use a token
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </LedgerGroup>
  );
}
