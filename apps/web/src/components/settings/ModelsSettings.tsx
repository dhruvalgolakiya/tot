import { useEffect, useRef, useState } from "react";
import { DropdownMenu } from "radix-ui";
import { toast } from "sonner";
import { Download, Ellipsis, Plus, RefreshCw } from "lucide-react";
import type { AccountPatch, AccountStatus, ProviderId } from "@tot/shared/types";
import { api, errorMessage } from "../../lib/api";
import { PROVIDER_LABELS } from "../../lib/models";
import type { SettingsSectionProps } from "../../lib/settings";
import { notifyError, refreshProviders, saveSettings } from "../../store";
import { Button } from "../ui/Button";
import { Callout } from "../ui/Callout";
import { Field } from "../ui/Field";
import { IconButton } from "../ui/IconButton";
import { LedgerField, LedgerGroup } from "../ui/Ledger";
import { RadioCards } from "../ui/RadioCards";
import { SecretInput } from "../ui/SecretInput";
import { Skeleton } from "../ui/Skeleton";
import { Switch } from "../ui/Switch";
import { TierSettings } from "../orchestration/TierSettings";
import { AccountRow } from "./AccountRow";
import { AddAccountDialog, ClaudeSignInDialog, ImportT3Dialog, RenameAccountDialog } from "./AccountDialogs";

const DRIVERS: ProviderId[] = ["claude", "chatgpt"];
const LOGIN_POLL_MS = 3_000;
const LOGIN_TIMEOUT_MS = 3 * 60_000;

/**
 * Settings → Models & accounts: every Claude and ChatGPT sign-in (the built-in ones use the default folders; others
 * are config folders, e.g. a CCS proxy), each provider's own options, and the model tiers. Account changes apply
 * right away; the options and tiers below go through the Save bar like the rest of the section.
 */
export function ModelsSettings({ draft, onChange, secrets, onSecretsChange }: SettingsSectionProps) {
  const [accounts, setAccounts] = useState<AccountStatus[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [renaming, setRenaming] = useState<AccountStatus | null>(null);
  const [claudeCommand, setClaudeCommand] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState<string | null>(null);
  const poll = useRef<number | undefined>(undefined);

  async function load(refresh = false) {
    setLoadError(null);
    try {
      setAccounts(await api.listAccounts({ refresh }));
    } catch (error) {
      setLoadError(errorMessage(error));
    }
  }

  useEffect(() => {
    void load();
    return () => window.clearInterval(poll.current);
  }, []);

  /** After any change: the accounts list, and the model menu (which lists every enabled account's models). */
  async function reload() {
    await Promise.all([load(true), refreshProviders({ quiet: true })]);
  }

  async function refresh() {
    setRefreshing(true);
    await reload();
    setRefreshing(false);
  }

  /** The account Auto and tasks use first for its provider: saved right away, like the other account changes. */
  async function makeDefault(account: AccountStatus) {
    const chosen = { ...(draft.models.accounts ?? { claude: "claude", chatgpt: "chatgpt" }), [account.driver]: account.id };
    if (!(await saveSettings({ models: { accounts: chosen } }))) return;
    onChange({ ...draft, models: { ...draft.models, accounts: chosen } });
    await reload();
  }

  async function patch(account: AccountStatus, change: AccountPatch) {
    setAccounts((list) => list?.map((a) => (a.id === account.id ? { ...a, ...change } : a)) ?? null);
    try {
      await api.updateAccount(account.id, change);
    } catch (error) {
      notifyError(error);
    }
    await reload();
  }

  async function remove(account: AccountStatus) {
    try {
      await api.deleteAccount(account.id);
      toast.success("Account removed");
    } catch (error) {
      notifyError(error);
    }
    await reload();
  }

  /** ChatGPT: open its sign-in page and wait for the account to report signed in. Claude: show the command. */
  async function signIn(account: AccountStatus) {
    const tab = account.driver === "chatgpt" ? window.open("about:blank", "_blank") : null;
    if (tab) tab.opener = null;
    let login;
    try {
      login = await api.loginAccount(account.id);
    } catch (error) {
      tab?.close();
      notifyError(error);
      return;
    }
    if (login.kind === "command") {
      setClaudeCommand(login.command);
      return;
    }
    if (tab) tab.location.href = login.url;
    else window.open(login.url, "_blank", "noopener");
    window.clearInterval(poll.current);
    setSigningIn(account.id);
    const startedAt = Date.now();
    poll.current = window.setInterval(async () => {
      if (Date.now() - startedAt > LOGIN_TIMEOUT_MS) {
        window.clearInterval(poll.current);
        setSigningIn(null);
        toast.error(`Didn't see ${account.name} signed in yet. Finish signing in, then press Refresh.`);
        return;
      }
      try {
        const list = await api.listAccounts({ refresh: true });
        setAccounts(list);
        if (list.find((a) => a.id === account.id)?.loggedIn) {
          window.clearInterval(poll.current);
          setSigningIn(null);
          toast.success(`${account.name} signed in`);
          void refreshProviders({ quiet: true });
        }
      } catch {
        // Keep polling; the server may be restarting the CLI.
      }
    }, LOGIN_POLL_MS);
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between gap-4 px-1">
        <p className="text-xs leading-relaxed text-fg-subtle">
          TOT runs on the subscriptions you already have: the default Claude and ChatGPT sign-ins, and any others in their own folders.
        </p>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" variant="ghost" onClick={() => setAdding(true)}>
            <Plus /> Add account
          </Button>
          <DropdownMenu.Root modal={false}>
            <DropdownMenu.Trigger asChild>
              <IconButton label="More account options" size="sm">
                <Ellipsis />
              </IconButton>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content align="end" sideOffset={4} className="menu w-52">
                <DropdownMenu.Item className="menu-item" onSelect={() => setImporting(true)}>
                  <Download className="size-4 text-fg-muted" /> Import from T3 Code…
                </DropdownMenu.Item>
                <DropdownMenu.Item className="menu-item" disabled={refreshing} onSelect={() => void refresh()}>
                  <RefreshCw className="size-4 text-fg-muted" /> Check sign-ins again
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </div>

      {loadError && (
        <Callout
          tone="danger"
          action={
            <button type="button" onClick={() => void load(true)} className="link-muted">
              Try again
            </button>
          }
        >
          Couldn't load your accounts. {loadError}
        </Callout>
      )}

      {DRIVERS.map((driver) => {
        const mine = accounts?.filter((a) => a.driver === driver);
        return (
          <LedgerGroup key={driver} title={PROVIDER_LABELS[driver]} count={mine?.length} body="rows">
            {!mine ? (
              <div aria-busy="true" aria-label={`Loading ${PROVIDER_LABELS[driver]} accounts`} className="space-y-2 p-2">
                <Skeleton className="h-4 w-1/3" />
                <Skeleton className="h-3 w-1/2" />
              </div>
            ) : (
              mine.map((account) => (
                <AccountRow
                  key={account.id}
                  account={account}
                  several={mine.filter((a) => a.enabled).length > 1}
                  signingIn={signingIn === account.id}
                  onRename={() => setRenaming(account)}
                  onToggleTools={(useAccountTools) => void patch(account, { useAccountTools })}
                  onToggleEnabled={(enabled) => void patch(account, { enabled })}
                  onSignIn={() => void signIn(account)}
                  onRemove={() => void remove(account)}
                  onMakeDefault={() => void makeDefault(account)}
                />
              ))
            )}
          </LedgerGroup>
        );
      })}

      <LedgerGroup title="Claude options" description="For the built-in Claude account. Other Claude accounts sign in through their own folder.">
        <LedgerField
          stacked
          title="Sign-in"
          description="How TOT reaches Claude."
          control={
            <RadioCards
              label="Claude sign-in"
              value={draft.claude.authMode}
              onValueChange={(authMode) => onChange({ ...draft, claude: { ...draft.claude, authMode } })}
              className="sm:grid-cols-2"
              options={[
                { value: "subscription", label: "Subscription", description: "Use the Claude Code login on this machine." },
                { value: "api-key", label: "API key", description: "Pay per token with an Anthropic API key." },
              ]}
            />
          }
        >
          {draft.claude.authMode === "api-key" && (
            <Field label="Anthropic API key" htmlFor="anthropic-key" className="mt-4">
              <SecretInput
                id="anthropic-key"
                placeholder="sk-ant-…"
                value={secrets.anthropicApiKey}
                onChange={(anthropicApiKey) => onSecretsChange((s) => ({ ...s, anthropicApiKey, clearAnthropicApiKey: false }))}
                saved={draft.claude.apiKeySet}
                cleared={secrets.clearAnthropicApiKey}
                onClearedChange={(clearAnthropicApiKey) => onSecretsChange((s) => ({ ...s, clearAnthropicApiKey }))}
              />
            </Field>
          )}
        </LedgerField>
        <LedgerField
          htmlFor="claude-connectors"
          title="Use my claude.ai connectors"
          description="Let Claude use the connectors (Gmail, Drive, …) connected to your claude.ai account."
          control={
            <Switch
              id="claude-connectors"
              checked={draft.claude.useConnectedApps}
              onCheckedChange={(useConnectedApps) => onChange({ ...draft, claude: { ...draft.claude, useConnectedApps } })}
            />
          }
        />
      </LedgerGroup>

      <LedgerGroup title="ChatGPT options">
        <LedgerField
          htmlFor="chatgpt-apps"
          title="Use my ChatGPT connected apps"
          description="Let ChatGPT use the apps and connectors on your ChatGPT account, when supported."
          control={
            <Switch
              id="chatgpt-apps"
              checked={draft.chatgpt.useConnectedApps}
              onCheckedChange={(useConnectedApps) => onChange({ ...draft, chatgpt: { ...draft.chatgpt, useConnectedApps } })}
            />
          }
        />
      </LedgerGroup>

      <TierSettings draft={draft} onChange={onChange} accounts={accounts ?? []} />

      <AddAccountDialog open={adding} onOpenChange={setAdding} onAdded={() => void reload()} />
      <ImportT3Dialog open={importing} onOpenChange={setImporting} onImported={() => void reload()} />
      <RenameAccountDialog account={renaming} onOpenChange={(open) => !open && setRenaming(null)} onRenamed={() => void reload()} />
      <ClaudeSignInDialog command={claudeCommand} onOpenChange={(open) => !open && setClaudeCommand(null)} onCheck={() => void refresh()} />
    </div>
  );
}
