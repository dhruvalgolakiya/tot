import { useEffect } from "react";
import { Linking } from "react-native";
import { Cell, Group, SettingsScroll, Status, SwitchCell } from "../../components/settings";
import { askForNotifications, type NotifyKind, refreshPermission, setNotifyPref, useNotify } from "../../lib/notify";

const KINDS: { kind: NotifyKind; title: string; subtitle: string }[] = [
  { kind: "approvals", title: "Needs your OK", subtitle: "An agent asks before an action, or a Lead asks to land, discard or push." },
  { kind: "tasks", title: "Tasks", subtitle: "A task needs your input, is done, or failed." },
  { kind: "replies", title: "Replies", subtitle: "An agent finished replying in a chat you're not looking at." },
];

/**
 * Settings → Notifications: whether iOS lets TOT notify (and the way to fix it when it doesn't), and each kind on or
 * off. Kept on the phone, not on the TOT: they're this phone's banners.
 */
export default function NotificationSettings() {
  const { prefs, permission } = useNotify();

  useEffect(() => {
    void refreshPermission().catch(() => {});
  }, []);

  const granted = Boolean(permission?.granted);
  const undecided = permission?.status === "undetermined";
  const state = !permission ? "—" : granted ? "On" : undecided ? "Not asked yet" : "Off in iOS Settings";

  return (
    <SettingsScroll>
      <Group
        footer={
          granted
            ? "TOT notifies while the app is open or was just closed; when you come back, it catches up on what you missed. Notifications that reach a locked phone at any time need push, which comes later."
            : undecided
              ? "TOT asks the first time you send a message. You can turn them on now."
              : "iOS won't show TOT's notifications. Turn on Allow Notifications in iOS Settings → TOT."
        }
      >
        <Cell title="Notifications" right={<Status label={state} tone={granted ? "success" : "neutral"} />} />
        {granted ? null : undecided ? (
          <Cell title="Turn on notifications" icon="bell" onPress={() => void askForNotifications()} />
        ) : (
          <Cell title="Open iOS Settings" icon="external-link" onPress={() => void Linking.openSettings()} />
        )}
      </Group>

      <Group title="Notify me about" footer="Never about the chat you have open.">
        {KINDS.map(({ kind, title, subtitle }) => (
          <SwitchCell key={kind} title={title} subtitle={subtitle} value={prefs[kind]} disabled={!granted} onValueChange={(on) => void setNotifyPref(kind, on)} />
        ))}
      </Group>
    </SettingsScroll>
  );
}
