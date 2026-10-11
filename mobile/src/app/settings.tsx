import Constants from "expo-constants";
import { Alert, ScrollView, StyleSheet, Text, View } from "react-native";
import { Button, Dot, Row, SectionTitle, Separator } from "../components/ui";
import { signOut, useConnection } from "../lib/connection";
import { useStore } from "../lib/store";
import { type as typeScale, useColors } from "../theme";

/**
 * M1's settings: which TOT this is, its paired devices, and Sign out. TOT's own settings (models, accounts,
 * tasks, memory, remote access) come to the phone in M3.
 */
export default function Settings() {
  const colors = useColors();
  const { url, token, deviceName } = useConnection();
  const devices = useStore((s) => s.devices);
  const live = useStore((s) => s.live);

  const confirm = () =>
    Alert.alert(`Sign out of ${deviceName ?? "TOT"}?`, "You can sign in again with a new code from Settings → Devices.", [
      { text: "Cancel", style: "cancel" },
      { text: "Sign out", style: "destructive", onPress: () => void signOut() },
    ]);

  const label = [typeScale.body, { color: colors.fg, flex: 1 }];
  const value = [typeScale.sm, { color: colors.fgSubtle }];

  return (
    <ScrollView style={{ backgroundColor: colors.canvas }} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={{ paddingBottom: 40 }}>
      <SectionTitle>Connected to</SectionTitle>
      <Row>
        <Text style={label}>{deviceName ?? "TOT"}</Text>
        <Dot color={live ? colors.success : colors.fgFaint} />
        <Text style={value}>{live ? "Live" : "Connecting"}</Text>
      </Row>
      <Separator />
      <Row>
        <Text style={label}>Address</Text>
        <Text numberOfLines={1} style={[value, { maxWidth: "60%" }]}>
          {url?.replace(/^https?:\/\//, "")}
        </Text>
      </Row>
      <Separator />
      <Row>
        <Text style={label}>Sign-in</Text>
        <Text style={value}>{token ? "Signed in as this phone" : "Not needed on this computer"}</Text>
      </Row>

      {devices?.devices.length ? (
        <>
          <SectionTitle>Paired devices</SectionTitle>
          {devices.devices.map((device, i) => (
            <View key={device.id}>
              {i ? <Separator /> : null}
              <Row>
                <Text style={label}>{device.name}</Text>
                <Dot color={device.online ? colors.success : colors.fgFaint} />
                <Text style={value}>{device.online ? "Online" : "Offline"}</Text>
              </Row>
            </View>
          ))}
        </>
      ) : null}

      <View style={styles.footer}>
        <Button label={token ? "Sign out" : "Disconnect"} variant="secondary" onPress={confirm} />
        <Text style={[typeScale.xs, { color: colors.fgSubtle, textAlign: "center" }]}>TOT for iPhone {Constants.expoConfig?.version ?? ""} · in development</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  footer: { paddingHorizontal: 16, paddingTop: 32, gap: 16 },
});
