import { useCallback, useEffect, useState } from "react";
import { Alert, Platform, RefreshControl, ScrollView, Text, View } from "react-native";
import type { AccountPatch, AccountStatus, ProviderId, ProviderStatus, Role, Tier } from "@shared/types";
import { Cell, Footnote, Group, Status, SwitchCell, Tag } from "../../components/settings";
import { showMenu } from "../../components/ui";
import { api, errorMessage } from "../../lib/api";
import { defaultTierLabel, PROVIDER_LABELS, PROVIDERS, ROLE_LABELS, ROLES, TIER_DESCRIPTIONS, TIER_LABELS, TIERS } from "../../lib/models";
import { loadModels, saveSettings, useStore } from "../../lib/store";
import { font, type as typeScale, useColors } from "../../theme";

/** Where an account stands, as the web's badge: off, at its limit, signed in (or through a proxy), or not signed in. */
function accountState(account: AccountStatus): { label: string; tone: "success" | "warning" | "neutral" } {
  if (!account.enabled) return { label: "Off", tone: "neutral" };
  if (account.limitedUntil) return { label: "At its limit", tone: "warning" };
  if (account.loggedIn) return { label: account.proxy ? "Proxy" : "Signed in", tone: "success" };
  return { label: "Not signed in", tone: "neutral" };
}

/** "Linear, Slack and 6 more". */
function names(list: string[]): string {
  if (list.length <= 3) return list.join(", ");
  return `${list.slice(0, 2).join(", ")} and ${list.length - 2} more`;
}

const ON_THE_COMPUTER = () =>
  Alert.alert("Do this on the computer", "Signing in and adding accounts open a browser or a Terminal on the computer that runs TOT. Do it in TOT there: Settings → Models & accounts.");

/**
 * Settings → Models & accounts, as the web's: every Claude and ChatGPT sign-in with where it stands and a "…" each
 * (Make default, Rename, the account's MCP servers, Turn off), the providers' options, and the model tiers. Signing
 * in and adding accounts need the computer's browser or Terminal, so the phone says so. Each change saves at once.
 */
export default function ModelsSettings() {
  const colors = useColors();
  const settings = useStore((s) => s.settings);
  const [accounts, setAccounts] = useState<AccountStatus[] | null>(null);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async (refresh = false) => {
    try {
      const [list, statuses] = await Promise.all([api.listAccounts({ refresh }), api.listProviders().catch(() => [] as ProviderStatus[])]);
      setAccounts(list);
      setProviders(statuses);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /** After an account change: the list, and the model menu (it lists every enabled account's models). */
  const reload = () => Promise.all([load(true), loadModels().catch(() => {})]);

  const patch = async (account: AccountStatus, change: AccountPatch) => {
    setAccounts((list) => list?.map((a) => (a.id === account.id ? { ...a, ...change } : a)) ?? null);
    try {
      await api.updateAccount(account.id, change);
    } catch (e) {
      Alert.alert("Couldn't change that", errorMessage(e));
    }
    await reload();
  };

  const makeDefault = async (account: AccountStatus) => {
    if (!settings) return;
    const chosen = { ...settings.models.accounts, [account.driver]: account.id };
    setAccounts((list) => list?.map((a) => (a.driver === account.driver ? { ...a, isDefault: a.id === account.id } : a)) ?? null);
    await saveSettings({ models: { accounts: chosen } });
    await reload();
  };

  const rename = (account: AccountStatus) =>
    Alert.prompt(
      "Rename account",
      "Its name in the model menu and here.",
      [
        { text: "Cancel", style: "cancel" },
        { text: "Rename", onPress: (value?: string) => (value?.trim() && value.trim() !== account.name ? void patch(account, { name: value.trim() }) : undefined) },
      ],
      "plain-text",
      account.name,
    );

  const more = (account: AccountStatus, several: boolean) =>
    showMenu(account.name, [
      ...(several && account.enabled && !account.isDefault ? [{ label: "Make default", onPress: () => void makeDefault(account) }] : []),
      // Alert.prompt is iOS-only; on Android, rename on the computer.
      ...(Platform.OS === "ios" ? [{ label: "Rename…", onPress: () => rename(account) }] : []),
      { label: account.loggedIn ? "Sign in again…" : "Sign in…", onPress: ON_THE_COMPUTER },
      {
        label: account.useAccountTools ? "Stop using this account's MCP servers" : "Use this account's MCP servers",
        onPress: () => void patch(account, { useAccountTools: !account.useAccountTools }),
      },
      { label: account.enabled ? "Turn off" : "Turn on", onPress: () => void patch(account, { enabled: !account.enabled }) },
    ]);

  const setTier = (tier: Tier, provider: ProviderId, model: string | null) => {
    if (!settings) return;
    const tiers = settings.models.tiers;
    void saveSettings({ models: { tiers: { ...tiers, [tier]: { ...tiers[tier], [provider]: model } } } });
  };

  const pickTier = (tier: Tier, provider: ProviderId) => {
    const status = providers.find((p) => p.id === provider);
    const models = (status?.models ?? []).filter((m) => m.available);
    showMenu(`${TIER_LABELS[tier]} on ${PROVIDER_LABELS[provider]}`, [
      { label: `TOT's default · ${defaultTierLabel(tier, provider, models)}`, onPress: () => setTier(tier, provider, null) },
      ...models.map((m) => ({ label: m.label, onPress: () => setTier(tier, provider, m.model) })),
    ]);
  };

  const setRole = (role: Role, tier: Tier) => settings && void saveSettings({ models: { roles: { ...settings.models.roles, [role]: tier } } });

  return (
    <ScrollView
      style={{ backgroundColor: colors.canvas }}
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingTop: 8, paddingBottom: 48 }}
      refreshControl={
        <RefreshControl
          tintColor={colors.fgSubtle}
          refreshing={refreshing}
          onRefresh={async () => {
            setRefreshing(true);
            await reload();
            setRefreshing(false);
          }}
        />
      }
    >
      <Footnote>TOT runs on the subscriptions you already have: the default Claude and ChatGPT sign-ins, and any others in their own folders. Pull down to check sign-ins again.</Footnote>

      {error && !accounts ? (
        <Group footer={`Couldn't load your accounts. ${error}`}>
          <Cell title="Try again" icon="refresh-cw" onPress={() => void load(true)} />
        </Group>
      ) : null}

      {PROVIDERS.map((driver) => {
        const mine = accounts?.filter((a) => a.driver === driver);
        if (!mine) return null;
        const several = mine.filter((a) => a.enabled).length > 1;
        return (
          <Group key={driver} title={PROVIDER_LABELS[driver]}>
            {mine.map((account) => (
              <AccountCell key={account.id} account={account} several={several} onPress={() => more(account, several)} />
            ))}
          </Group>
        );
      })}

      {accounts ? (
        <Group footer="Adding an account picks a folder, and importing reads T3 Code's settings, on the computer.">
          <Cell title="Add account" icon="plus" onPress={ON_THE_COMPUTER} />
          <Cell title="Import from T3 Code" icon="download" onPress={ON_THE_COMPUTER} />
        </Group>
      ) : null}

      {settings ? (
        <>
          <Group title="Claude options" footer="For the built-in Claude account. Other Claude accounts sign in through their own folder.">
            <Cell title="Sign-in" value={settings.claude.authMode === "api-key" ? "API key" : "Subscription"} />
            <SwitchCell
              title="Use my claude.ai connectors"
              subtitle="Let Claude use the connectors (Gmail, Drive, …) connected to your claude.ai account."
              value={settings.claude.useConnectedApps}
              onValueChange={(useConnectedApps) => void saveSettings({ claude: { useConnectedApps } })}
            />
          </Group>

          <Group title="ChatGPT options">
            <SwitchCell
              title="Use my ChatGPT connected apps"
              subtitle="Let ChatGPT use the apps and connectors on your ChatGPT account, when supported."
              value={settings.chatgpt.useConnectedApps}
              onValueChange={(useConnectedApps) => void saveSettings({ chatgpt: { useConnectedApps } })}
            />
          </Group>

          <View style={{ marginTop: 28, paddingHorizontal: 16 }}>
            <Text style={[typeScale.heading, { color: colors.fg, paddingHorizontal: 16 }]}>Model tiers</Text>
            <Footnote>
              TOT Auto runs each turn on a tier: fast for quick asks, deep for hard work, and whatever a task's role needs. Pick the model behind each one, or leave TOT's default.
            </Footnote>
          </View>
          {TIERS.map((tier) => (
            <Group key={tier} title={`${TIER_LABELS[tier]} · ${TIER_DESCRIPTIONS[tier]}`}>
              {PROVIDERS.map((provider) => {
                const status = providers.find((p) => p.id === provider);
                const models = (status?.models ?? []).filter((m) => m.available);
                const chosen = settings.models.tiers[tier][provider];
                const label = chosen ? (models.find((m) => m.model === chosen)?.label ?? chosen) : `Default · ${defaultTierLabel(tier, provider, models)}`;
                return (
                  <Cell key={provider} title={PROVIDER_LABELS[provider]} value={label} chevron disabled={!status?.loggedIn} onPress={() => pickTier(tier, provider)} />
                );
              })}
            </Group>
          ))}

          <Group
            title="Tiers for task roles"
            footer="When TOT splits work across tasks, each gets a role. A reviewer always runs on the other provider from the work it reviews."
          >
            {ROLES.map((role) => (
              <Cell
                key={role}
                title={ROLE_LABELS[role]}
                value={TIER_LABELS[settings.models.roles[role]]}
                chevron
                onPress={() => showMenu(`Tier for ${ROLE_LABELS[role]}`, TIERS.map((tier) => ({ label: TIER_LABELS[tier], onPress: () => setRole(role, tier) })))}
              />
            ))}
          </Group>
        </>
      ) : null}
    </ScrollView>
  );
}

/** One account: its name (Default when it's the one Auto and tasks use), folder, sign-in and tools; its "…" on tap. */
function AccountCell({ account, several, onPress }: { account: AccountStatus; several: boolean; onPress: () => void }) {
  const colors = useColors();
  const state = accountState(account);
  const who = [account.authMethod, account.email].filter(Boolean).join(" · ");
  // Key names only: the values never leave the computer.
  const proxyNote = account.proxy ? `Uses a proxy: ${account.envKeys.filter((key) => key.startsWith("ANTHROPIC_")).slice(0, 2).join(", ")} set` : "";
  const tools = account.useAccountTools
    ? [account.mcpServers.length ? `MCP: ${names(account.mcpServers)}` : "", account.plugins.length ? `Plugins: ${names(account.plugins)}` : ""].filter(Boolean).join(" · ")
    : account.mcpServers.length
      ? `${account.mcpServers.length} MCP server${account.mcpServers.length === 1 ? "" : "s"}, not used`
      : "";
  const problem = account.enabled && !account.loggedIn && account.detail ? account.detail : "";
  const lines = [proxyNote || who, tools, problem].filter(Boolean);
  return (
    <Cell
      title={
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <Text numberOfLines={1} style={[typeScale.body, { fontFamily: font.medium, color: colors.fg, flexShrink: 1 }]}>
            {account.name}
          </Text>
          {several && account.isDefault && account.enabled ? <Tag>Default</Tag> : null}
        </View>
      }
      subtitle={
        <View style={{ gap: 2 }}>
          <Text numberOfLines={1} style={{ fontFamily: font.mono, fontSize: 11, lineHeight: 15, color: colors.fgSubtle }}>
            {account.dir}
          </Text>
          {lines.map((line) => (
            <Text key={line} numberOfLines={2} style={[typeScale.xs, { color: colors.fgSubtle }]}>
              {line}
            </Text>
          ))}
        </View>
      }
      right={<Status label={state.label} tone={state.tone} />}
      chevron
      onPress={onPress}
    />
  );
}
