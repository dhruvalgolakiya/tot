import { useState } from "react";
import clsx from "clsx";
import { LoaderCircle, LogIn, RefreshCw } from "lucide-react";
import type { SettingsSectionProps } from "../../lib/settings";
import { connectProvider, refreshProviders, useStore } from "../../store";
import { Button } from "../ui/Button";
import { Field } from "../ui/Field";
import { RadioCards } from "../ui/RadioCards";
import { SecretInput } from "../ui/SecretInput";
import { Switch } from "../ui/Switch";
import { ProviderCard } from "./ProviderCard";
import { SettingRow } from "./SettingRow";

export function ModelsSettings({ draft, onChange, secrets, onSecretsChange }: SettingsSectionProps) {
  const providers = useStore((s) => s.providers);
  const connecting = useStore((s) => s.connectingProvider);
  const [refreshing, setRefreshing] = useState(false);
  const claude = providers.find((p) => p.id === "claude");
  const chatgpt = providers.find((p) => p.id === "chatgpt");

  async function refresh() {
    setRefreshing(true);
    await refreshProviders();
    setRefreshing(false);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm leading-relaxed text-zinc-400">
          TOT runs on the subscriptions you already have. Connect one or both.
        </p>
        <Button size="sm" variant="ghost" onClick={() => void refresh()} disabled={refreshing}>
          <RefreshCw className={clsx(refreshing && "animate-spin")} /> Refresh
        </Button>
      </div>

      <ProviderCard id="claude" provider={claude}>
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
        {draft.claude.authMode === "api-key" && (
          <Field label="Anthropic API key" htmlFor="anthropic-key">
            <SecretInput
              id="anthropic-key"
              placeholder="sk-ant-…"
              value={secrets.anthropicApiKey}
              onChange={(anthropicApiKey) =>
                onSecretsChange((s) => ({ ...s, anthropicApiKey, clearAnthropicApiKey: false }))
              }
              saved={draft.claude.apiKeySet}
              cleared={secrets.clearAnthropicApiKey}
              onClearedChange={(clearAnthropicApiKey) => onSecretsChange((s) => ({ ...s, clearAnthropicApiKey }))}
            />
          </Field>
        )}
        <SettingRow
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
      </ProviderCard>

      <ProviderCard
        id="chatgpt"
        provider={chatgpt}
        action={
          chatgpt && !chatgpt.loggedIn ? (
            <Button size="sm" variant="primary" onClick={() => void connectProvider("chatgpt")} disabled={connecting === "chatgpt"}>
              {connecting === "chatgpt" ? <LoaderCircle className="animate-spin" /> : <LogIn />}
              {connecting === "chatgpt" ? "Waiting for login…" : "Connect ChatGPT"}
            </Button>
          ) : null
        }
      >
        <SettingRow
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
      </ProviderCard>
    </div>
  );
}
