import Constants from "expo-constants";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, StyleSheet, Text, View } from "react-native";
import type { AppsStatus, GitHubStatus, Persona, Plugin, SlackStatus } from "@shared/types";
import { Cell, Group, SettingsScroll, Status } from "../../components/settings";
import { Button } from "../../components/ui";
import { api } from "../../lib/api";
import { signOut, useConnection } from "../../lib/connection";
import { useStore } from "../../lib/store";
import { type as typeScale, useColors } from "../../theme";

/** What's set up only on the computer (it needs its screen, a browser sign-in or a token), as the phone shows it. */
interface Elsewhere {
  github: GitHubStatus | null;
  slack: SlackStatus | null;
  apps: AppsStatus | null;
  personas: Persona[] | null;
  plugins: Plugin[] | null;
}

const SET_UP = "Set up on the computer";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function githubLine(status: GitHubStatus | null): string {
  if (!status) return "—";
  if (status.problem) return "Reconnect on the computer";
  return status.connection ? `@${status.connection.login}` : SET_UP;
}

function slackLine(status: SlackStatus | null): string {
  if (!status) return "—";
  if (status.state === "connected") return status.workspace ?? "Connected";
  if (status.state === "connecting") return "Connecting…";
  if (status.state === "error") return "Needs a look on the computer";
  return SET_UP;
}

function appsLine(status: AppsStatus | null): string {
  if (!status) return "—";
  if (status.state === "running") return status.apps.length ? plural(status.apps.length, "app") : "On · no apps yet";
  if (status.state === "installing" || status.state === "starting") return "Starting…";
  if (status.state === "error") return "Needs a look on the computer";
  return SET_UP;
}

/**
 * Settings, as the web's section list: which TOT this is, the sections that make sense on a phone (each its own
 * screen, saving every change at once), and what's set up only on the computer, read-only. Sign out at the end.
 */
export default function Settings() {
  const colors = useColors();
  const router = useRouter();
  const { url, token, deviceName } = useConnection();
  const live = useStore((s) => s.live);
  const [elsewhere, setElsewhere] = useState<Elsewhere>({ github: null, slack: null, apps: null, personas: null, plugins: null });

  useEffect(() => {
    // Each on its own: an older TOT, or one without that module, just shows a dash.
    void api.getGithub().then((github) => setElsewhere((e) => ({ ...e, github })), () => {});
    void api.getSlack().then((slack) => setElsewhere((e) => ({ ...e, slack })), () => {});
    void api.getApps().then((apps) => setElsewhere((e) => ({ ...e, apps })), () => {});
    void api.listPersonas().then((personas) => setElsewhere((e) => ({ ...e, personas })), () => {});
    void api.listPlugins().then((plugins) => setElsewhere((e) => ({ ...e, plugins })), () => {});
  }, []);

  const confirmSignOut = () =>
    Alert.alert(`Sign out of ${deviceName ?? "TOT"}?`, "You can sign in again with a new code from Settings → Devices.", [
      { text: "Cancel", style: "cancel" },
      { text: "Sign out", style: "destructive", onPress: () => void signOut() },
    ]);

  const open = (section: string) => router.push(`/settings/${section}`);
  const enabledPlugins = elsewhere.plugins?.filter((p) => p.enabled).length ?? 0;

  return (
    <SettingsScroll>
      <Group title="Connected to">
        <Cell title={deviceName ?? "TOT"} right={<Status label={live ? "Live" : "Connecting"} tone={live ? "success" : "neutral"} />} />
        <Cell title="Address" value={url?.replace(/^https?:\/\//, "") ?? ""} />
        <Cell title="Sign-in" value={token ? "Signed in as this phone" : "Not needed here"} />
      </Group>

      <Group>
        <Cell title="General" icon="sliders" chevron onPress={() => open("general")} />
        <Cell title="Models & accounts" icon="star" chevron onPress={() => open("models")} />
        <Cell title="Tasks" icon="list" chevron onPress={() => open("tasks")} />
        <Cell title="Memory" icon="book-open" chevron onPress={() => open("memory")} />
        <Cell title="Devices" icon="smartphone" chevron onPress={() => open("devices")} />
      </Group>

      <Group title="On the computer" footer="These sign in through a browser or keep a token, so they're set up in TOT on your computer.">
        <Cell title="GitHub" icon="github" value={githubLine(elsewhere.github)} />
        <Cell title="Slack" icon="slack" value={slackLine(elsewhere.slack)} />
        <Cell title="Apps" icon="grid" value={appsLine(elsewhere.apps)} />
        <Cell title="Personas" icon="user" value={elsewhere.personas ? (elsewhere.personas.length ? plural(elsewhere.personas.length, "persona") : SET_UP) : "—"} />
        <Cell title="Plugins" icon="box" value={elsewhere.plugins ? (enabledPlugins ? `${enabledPlugins} on` : SET_UP) : "—"} />
      </Group>

      <View style={styles.footer}>
        <Button label={token ? "Sign out" : "Disconnect"} variant="secondary" onPress={confirmSignOut} />
        <Text style={[typeScale.xs, { color: colors.fgSubtle, textAlign: "center" }]}>TOT for iPhone {Constants.expoConfig?.version ?? ""} · in development</Text>
      </View>
    </SettingsScroll>
  );
}

const styles = StyleSheet.create({
  footer: { paddingHorizontal: 16, paddingTop: 32, gap: 16 },
});
