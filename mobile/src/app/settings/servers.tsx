import { useRouter } from "expo-router";
import { Alert } from "react-native";
import { Cell, Group, SettingsScroll } from "../../components/settings";
import { showMenu } from "../../components/ui";
import { removeServer, type SavedServer, serverLabel, startAdding, switchServer, useConnection } from "../../lib/connection";

/**
 * Settings → TOT servers: every TOT this phone is signed in to (a home Mac and a work Mac, say), which one is open,
 * and Add another (through Connect). Tapping one opens a menu: Open it, or Remove it (which signs this phone out
 * there). Most people need one: a TOT already shows its paired devices' agents.
 */
export default function Servers() {
  const router = useRouter();
  const { servers, serverId } = useConnection();

  const open = async (server: SavedServer) => {
    await switchServer(server.id);
    // The lists on every screen were the other TOT's: start over at its Agents.
    if (router.canDismiss()) router.dismissAll();
  };

  const remove = (server: SavedServer) =>
    Alert.alert(
      `Remove ${serverLabel(server)}?`,
      server.signedIn ? "This phone signs out there and forgets it. You can sign in again with a new code from Settings → Devices." : "This phone forgets it.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Remove",
          style: "destructive",
          onPress: () => {
            const wasOpen = server.id === serverId;
            void removeServer(server.id).then(() => {
              if (wasOpen && router.canDismiss()) router.dismissAll();
            });
          },
        },
      ],
    );

  const menu = (server: SavedServer) =>
    showMenu(serverLabel(server), [
      ...(server.id === serverId ? [] : [{ label: "Open", onPress: () => void open(server) }]),
      { label: "Remove", destructive: true, onPress: () => remove(server) },
    ]);

  const add = () => {
    startAdding();
    router.push("/connect");
  };

  return (
    <SettingsScroll>
      <Group footer="One TOT already shows its paired devices' agents. Add another for a computer that isn't paired with it, like a work Mac on another network.">
        {servers.map((server) => (
          <Cell
            key={server.id}
            title={serverLabel(server)}
            subtitle={server.url.replace(/^https?:\/\//, "")}
            value={server.id === serverId ? "Open" : undefined}
            onPress={() => menu(server)}
          />
        ))}
        <Cell title="Add a TOT" icon="plus" onPress={add} />
      </Group>
    </SettingsScroll>
  );
}
