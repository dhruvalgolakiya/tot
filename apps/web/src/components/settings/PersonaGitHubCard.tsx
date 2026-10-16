import { useState, type FormEvent } from "react";
import { DropdownMenu } from "radix-ui";
import { Ellipsis, Unplug } from "lucide-react";
import type { Persona } from "@tot/shared/types";
import { api, errorMessage } from "../../lib/api";
import { notifyError, setPersona } from "../../store";
import { ConfirmDialog } from "../ConfirmDialog";
import { Button } from "../ui/Button";
import { Callout } from "../ui/Callout";
import { IconButton } from "../ui/IconButton";
import { LedgerField, LedgerGroup } from "../ui/Ledger";
import { SecretInput } from "../ui/SecretInput";
import { Switch } from "../ui/Switch";

const TOKEN_URL = "https://github.com/settings/tokens";
const SIGNUP_URL = "https://github.com/signup";

/** This persona's own GitHub account, separate from the app-wide one. */
export function PersonaGitHubCard({ persona }: { persona: Persona }) {
  return persona.github ? <ConnectedGitHub persona={persona} /> : <ConnectGitHub persona={persona} />;
}

function ConnectGitHub({ persona }: { persona: Persona }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect(event: FormEvent) {
    event.preventDefault();
    const value = token.trim();
    if (!value || busy) return;
    setBusy(true);
    setError(null);
    try {
      setPersona(await api.connectPersonaGithub(persona.id, { token: value }));
      setToken("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <LedgerGroup title="GitHub" description="This persona's GitHub account">
      <form onSubmit={(event) => void connect(event)}>
        <LedgerField
          stacked
          title="Personal access token"
          htmlFor={`persona-github-token-${persona.id}`}
          description={
            <>
              Create a{" "}
              <a href={SIGNUP_URL} target="_blank" rel="noopener noreferrer" className="link">
                GitHub account
              </a>{" "}
              with {persona.email}, then create a{" "}
              <a href={TOKEN_URL} target="_blank" rel="noopener noreferrer" className="link">
                token
              </a>{" "}
              in that account.
            </>
          }
          control={
            <div className="space-y-3">
              <SecretInput
                id={`persona-github-token-${persona.id}`}
                value={token}
                onChange={(value) => {
                  setToken(value);
                  setError(null);
                }}
                saved={false}
                cleared={false}
                onClearedChange={() => {}}
                placeholder="ghp_… or github_pat_…"
              />
              {error && <Callout tone="danger">{error}</Callout>}
              <Button type="submit" variant="primary" size="sm" disabled={!token.trim() || busy}>
                {busy ? "Connecting…" : "Connect"}
              </Button>
            </div>
          }
        />
      </form>
    </LedgerGroup>
  );
}

function ConnectedGitHub({ persona }: { persona: Persona }) {
  const github = persona.github!;
  const [writesSaving, setWritesSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);

  async function setWrites(allowWrites: boolean) {
    setWritesSaving(true);
    try {
      setPersona(await api.setPersonaGithubWrites(persona.id, allowWrites));
    } catch (error) {
      notifyError(error);
    } finally {
      setWritesSaving(false);
    }
  }

  async function disconnect() {
    try {
      setPersona(await api.disconnectPersonaGithub(persona.id));
    } catch (error) {
      notifyError(error);
    }
  }

  return (
    <>
      <LedgerGroup title="GitHub" description="This persona's GitHub account">
        <LedgerField
          title={
            <span className="flex items-center gap-2">
              {github.avatarUrl && <img src={github.avatarUrl} alt="" className="size-6 shrink-0 rounded-full" />}
              <span className="min-w-0 truncate">{github.name ?? github.login}</span>
            </span>
          }
          description={`@${github.login}`}
          control={
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
        >
          {github.problem && <Callout tone="warning">{github.problem}</Callout>}
        </LedgerField>

        <LedgerField
          htmlFor={`persona-github-writes-${persona.id}`}
          title="Agents can push and open pull requests"
          description="Off: GitHub tools are read-only and pushes are blocked. On: agents work on branches and open pull requests when you ask; merging and pushing to the main branch stay off-limits unless you ask. For a hard read-only guarantee, connect a read-only token."
          control={
            <Switch
              id={`persona-github-writes-${persona.id}`}
              checked={github.allowWrites}
              onCheckedChange={(checked) => void setWrites(checked)}
              disabled={writesSaving}
            />
          }
        />
      </LedgerGroup>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Disconnect GitHub?"
        description={`Agents working as ${persona.name} lose access to its GitHub account.`}
        confirmLabel="Disconnect"
        onConfirm={() => void disconnect()}
      />
    </>
  );
}
