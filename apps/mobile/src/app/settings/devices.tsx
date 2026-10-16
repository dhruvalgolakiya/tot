import { useCallback, useEffect, useState } from "react";
import { Alert } from "react-native";
import type { Device, DevicesStatus, SignInSession } from "@tot/shared/types";
import { Cell, Group, LoadState, SettingsScroll, Status } from "../../components/settings";
import { confirm } from "../../components/ui";
import { api, errorMessage } from "../../lib/api";
import { signOut, useConnection } from "../../lib/connection";
import { agoText } from "../../lib/format";
import { useStore } from "../../lib/store";

const MODE_LINE = { tailscale: "On · over Tailscale, from anywhere", lan: "On · on this Wi‑Fi only" } as const;

function reachLine(self: Device): string {
  if (!self.address) return "Only this computer can open TOT";
  if (self.network === "tailscale") return "Reachable over Tailscale, from anywhere";
  if (self.network === "lan") return "Reachable on this Wi‑Fi";
  return "Reachable at its address";
}

function deviceLine(device: Device): string {
  if (device.problem) return device.problem;
  if (device.online) return device.canReachUs ? "Online" : "Online · it can't reach this device";
  return `Offline${device.lastSeenAt ? ` · seen ${agoText(device.lastSeenAt)}` : ""}`;
}

/**
 * Settings → Devices, as the web's, for a phone: this computer and how it's reached (remote access is switched on
 * the computer), the browsers and phones signed in to it with Sign out (this phone's too), and the paired devices.
 * Pairing and the password are set on the computers themselves.
 */
export default function DevicesSettings() {
  const token = useConnection((s) => s.token);
  const [status, setStatus] = useState<DevicesStatus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const next = await api.getDevices();
      setStatus(next);
      useStore.setState({ devices: next });
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (!status) return <SettingsScroll><LoadState error={error} onRetry={() => void load()} /></SettingsScroll>;

  const { self, access } = status;
  const others = status.sessions.filter((s) => !s.current).length;

  const signOutSession = async (session: SignInSession) => {
    if (session.current) {
      if (await confirm(`Sign out of ${self.name}?`, "You can sign in again with a new code from Settings → Devices.", "Sign out", true)) void signOut();
      return;
    }
    if (!(await confirm(`Sign out ${session.label}?`, "Its next request is refused and it goes back to the sign-in page.", "Sign out", true))) return;
    try {
      setStatus(await api.signOutSession(session.id));
    } catch (e) {
      Alert.alert("Couldn't sign it out", errorMessage(e));
    }
  };

  const signOutOthers = async () => {
    if (!(await confirm("Sign out all others?", `Every browser and phone but this one goes back to the sign-in page.`, "Sign out", true))) return;
    try {
      setStatus(await api.signOutOtherSessions());
    } catch (e) {
      Alert.alert("Couldn't sign them out", errorMessage(e));
    }
  };

  return (
    <SettingsScroll>
      <Group title="This device" footer="Its name, password and network are changed on the computer.">
        <Cell title={self.name} subtitle={reachLine(self)} icon="monitor" />
        <Cell
          title="Remote access"
          subtitle={access.mode === "off" ? "Off · only this computer can open TOT. Your password is kept." : MODE_LINE[access.mode]}
          right={<Status label={access.mode === "off" ? "Off" : "On"} tone={access.mode === "off" ? "neutral" : "success"} />}
        />
        {access.addresses[0] ? <Cell title="Address" value={access.addresses[0].url.replace(/^https?:\/\//, "")} /> : null}
        {access.problem ? <Cell title={access.problem} icon="alert-triangle" /> : null}
      </Group>

      {status.signIn ? (
        <Group title="Signed in" footer="Phones and browsers on other devices. This computer never needs to sign in. Tap one to sign it out.">
          {status.sessions.map((session) => (
            <Cell
              key={session.id}
              icon={/iPhone|iPad|Android|TOT app/.test(session.label) ? "smartphone" : "globe"}
              title={session.label}
              subtitle={session.current ? (token ? "This phone" : "This browser") : `Active ${agoText(session.lastSeenAt)}`}
              onPress={() => void signOutSession(session)}
            />
          ))}
          {status.sessions.length ? null : <Cell title="No other devices signed in yet" />}
          {others > 1 ? <Cell title="Sign out all others" destructive onPress={() => void signOutOthers()} /> : null}
        </Group>
      ) : null}

      <Group title="Paired devices" footer="Use their agents from here, and this device's agents from there. Pair on the computers.">
        {status.devices.map((device) => (
          <Cell key={device.id} icon="monitor" title={device.name} subtitle={deviceLine(device)} right={<Status label={device.online ? "Online" : "Offline"} tone={device.online ? "success" : "neutral"} />} />
        ))}
        {status.devices.length ? null : <Cell title="No paired devices yet" />}
      </Group>
    </SettingsScroll>
  );
}
