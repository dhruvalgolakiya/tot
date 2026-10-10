import type { AccountStatus, ProviderId, Role, Settings, Tier } from "@shared/types";
import { PROVIDER_LABELS } from "../../lib/models";
import { ROLE_LABELS, ROLES, TIER_DESCRIPTIONS, TIER_LABELS, TIERS } from "../../lib/orchestration";
import { useStore } from "../../store";
import { LedgerGroup } from "../ui/Ledger";
import { Select } from "../ui/Select";

const PROVIDERS: ProviderId[] = ["claude", "chatgpt"];

/** TOT's own pick for a tier when nothing is chosen (mirrors server/orchestration/tiers.ts, for the label). */
function defaultLabel(tier: Tier, provider: ProviderId, models: { model: string; label: string }[]): string {
  if (provider === "claude") return tier === "deep" ? "Opus 5.5" : "Sonnet 5.5";
  const deep = models[0];
  const newest = (family: string) =>
    models
      .filter((m) => m.model !== deep?.model && new RegExp(`-${family}$`).test(m.model))
      .sort((a, b) => Number(/gpt-(\d+(?:\.\d+)?)/.exec(b.model)?.[1] ?? 0) - Number(/gpt-(\d+(?:\.\d+)?)/.exec(a.model)?.[1] ?? 0))[0];
  const standard = newest("sol") ?? deep;
  const pick = tier === "deep" ? deep : tier === "standard" ? standard : (newest("luna") ?? standard);
  return pick?.label ?? "None available";
}

/**
 * Settings → Models: which account TOT Auto and tasks use per provider (when there's more than one), the model each
 * tier uses on each provider, and the tier each role runs on.
 */
export function TierSettings({ draft, onChange, accounts = [] }: { draft: Settings; onChange: (next: Settings) => void; accounts?: AccountStatus[] }) {
  const providers = useStore((s) => s.providers);
  const { tiers, roles } = draft.models;
  const chosenAccounts = draft.models.accounts ?? { claude: "claude", chatgpt: "chatgpt" };
  const setAccount = (provider: ProviderId, id: string) =>
    onChange({ ...draft, models: { ...draft.models, accounts: { ...chosenAccounts, [provider]: id } } });
  const several = PROVIDERS.filter((provider) => accounts.filter((a) => a.driver === provider && a.enabled).length > 1);
  const setTier = (tier: Tier, provider: ProviderId, model: string) =>
    onChange({ ...draft, models: { ...draft.models, tiers: { ...tiers, [tier]: { ...tiers[tier], [provider]: model || null } } } });
  const setRole = (role: Role, tier: Tier) => onChange({ ...draft, models: { ...draft.models, roles: { ...roles, [role]: tier } } });

  return (
    <div className="space-y-8">
      {several.length > 0 && (
        <LedgerGroup title="Accounts for Auto and tasks" description="TOT Auto and tasks run on this account of each provider. When it's at its usage limit, another signed-in account of the same provider takes over before Auto moves to the other provider.">
          {several.map((provider) => (
            <div key={provider} className="flex items-center justify-between gap-4 px-4 py-2.5">
              <span className="text-sm text-fg">{PROVIDER_LABELS[provider]}</span>
              <Select
                size="sm"
                className="w-48"
                aria-label={`Account for ${PROVIDER_LABELS[provider]}`}
                value={accounts.some((a) => a.id === chosenAccounts[provider] && a.enabled) ? chosenAccounts[provider] : provider}
                onValueChange={(id) => setAccount(provider, id)}
                options={accounts.filter((a) => a.driver === provider && a.enabled).map((a) => ({ value: a.id, label: a.name }))}
              />
            </div>
          ))}
        </LedgerGroup>
      )}

      <LedgerGroup
        title="Model tiers"
        description="TOT Auto runs each turn on a tier: fast for quick asks, deep for hard work, and whatever a task's role needs. Pick the model behind each one, or leave TOT's default."
      >
        {TIERS.map((tier) => (
          <div key={tier} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
            <div className="min-w-0 sm:w-40">
              <p className="text-sm font-medium text-fg">{TIER_LABELS[tier]}</p>
              <p className="text-xs text-fg-subtle">{TIER_DESCRIPTIONS[tier]}</p>
            </div>
            <div className="grid flex-1 grid-cols-2 gap-2">
              {PROVIDERS.map((provider) => {
                const status = providers.find((p) => p.id === provider);
                const models = (status?.models ?? []).filter((m) => m.available);
                return (
                  <Select
                    key={provider}
                    size="sm"
                    aria-label={`${TIER_LABELS[tier]} tier on ${PROVIDER_LABELS[provider]}`}
                    value={tiers[tier][provider] ?? ""}
                    onValueChange={(model) => setTier(tier, provider, model)}
                    disabled={!status?.loggedIn}
                    options={[
                      { value: "", label: `${PROVIDER_LABELS[provider]} · ${defaultLabel(tier, provider, models)}` },
                      ...models.map((m) => ({ value: m.model, label: m.label })),
                    ]}
                  />
                );
              })}
            </div>
          </div>
        ))}
      </LedgerGroup>

      <LedgerGroup
        title="Tiers for task roles"
        description="When TOT splits work across tasks, each gets a role. A reviewer always runs on the other provider from the work it reviews."
      >
        {ROLES.map((role) => (
          <div key={role} className="flex items-center justify-between gap-4 px-4 py-2.5">
            <span className="text-sm text-fg">{ROLE_LABELS[role]}</span>
            <Select
              size="sm"
              className="w-36"
              aria-label={`Tier for ${ROLE_LABELS[role]}`}
              value={roles[role]}
              onValueChange={(tier) => setRole(role, tier as Tier)}
              options={TIERS.map((tier) => ({ value: tier, label: TIER_LABELS[tier] }))}
            />
          </div>
        ))}
      </LedgerGroup>
    </div>
  );
}
