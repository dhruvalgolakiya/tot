import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { serverLabel, useConnection } from "../lib/connection";
import { agoText } from "../lib/format";
import { retryNow, useStore } from "../lib/store";
import { font, type as typeScale, useColors } from "../theme";
import { useNow } from "./ui";

/**
 * "Reconnecting to Mac mini…" at the top of a screen while the TOT can't be reached, over the lists last loaded
 * from it (read-only until it's back). The app keeps trying with backoff; Retry tries now. Nothing shows while it's
 * reachable, or for a blip of a second or two (see the store's DROP_GRACE_MS).
 */
export function ConnectionBanner() {
  const colors = useColors();
  const reachable = useStore((s) => s.reachable);
  const cachedAt = useStore((s) => s.cachedAt);
  const name = useConnection((s) => (s.url ? serverLabel({ deviceName: s.deviceName, url: s.url }) : "TOT"));
  const now = useNow(!reachable, 30_000);
  if (reachable) return null;
  return (
    <View accessibilityRole="alert" accessibilityLiveRegion="polite" style={[styles.banner, { backgroundColor: colors.fill, borderBottomColor: colors.hairline }]}>
      <ActivityIndicator size="small" color={colors.fgSubtle} />
      <View style={{ flex: 1 }}>
        <Text numberOfLines={1} style={[typeScale.sm, { fontFamily: font.medium, color: colors.fg }]}>
          Reconnecting to {name}…
        </Text>
        <Text numberOfLines={2} style={[typeScale.xs, { color: colors.fgSubtle }]}>
          {cachedAt ? `Showing what was loaded ${agoText(cachedAt, now)}.` : "Showing what was loaded last."} Changes wait until it's back.
        </Text>
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel="Retry now" hitSlop={8} onPress={retryNow} style={({ pressed }) => [styles.retry, { borderColor: colors.edge }, pressed && { backgroundColor: colors.selected }]}>
        <Text style={[typeScale.ui, { fontFamily: font.medium, color: colors.fg }]}>Retry</Text>
      </Pressable>
    </View>
  );
}

/** True while the app shows the last loaded lists instead of the TOT's: screens turn their writes off. */
export const useOffline = () => useStore((s) => !s.reachable);

const styles = StyleSheet.create({
  banner: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
  retry: { height: 30, borderRadius: 15, paddingHorizontal: 12, borderWidth: StyleSheet.hairlineWidth * 2, alignItems: "center", justifyContent: "center" },
});
