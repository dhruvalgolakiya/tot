import Feather from "@expo/vector-icons/Feather";
import { type ComponentProps, type ReactNode, useEffect, useState } from "react";
import { ActionSheetIOS, ActivityIndicator, Alert, Platform, Pressable, type PressableProps, StyleSheet, Text, View, type ViewStyle } from "react-native";
import { font, type as typeScale, useColors } from "../theme";

export type IconName = ComponentProps<typeof Feather>["name"];

/** Feather icons (lucide is a fork of Feather), stroke-like and muted by default. */
export function Icon({ name, size = 18, color }: { name: IconName; size?: number; color?: string }) {
  const colors = useColors();
  return <Feather name={name} size={size} color={color ?? colors.fgMuted} />;
}

/** The agent's mascot (components/mascot), drawn like the web's. */
export { Mascot } from "./mascot/Mascot";

/** A pill button: primary is monochrome (fg on canvas), like the web app; secondary is a hairline outline. */
export function Button({
  label,
  onPress,
  variant = "primary",
  busy = false,
  disabled = false,
  icon,
  style,
  onDark = false,
}: {
  label: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "ghost";
  busy?: boolean;
  disabled?: boolean;
  icon?: IconName;
  style?: ViewStyle;
  /** White on black whatever the theme, for the camera screen. */
  onDark?: boolean;
}) {
  const themed = useColors();
  const colors = onDark ? { ...themed, fg: "#fff", canvas: "#000", edge: "rgba(255,255,255,0.3)" } : themed;
  const primary = variant === "primary";
  const fg = primary ? colors.canvas : colors.fg;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled || busy}
      style={({ pressed }) => [
        styles.button,
        primary && { backgroundColor: colors.fg },
        variant === "secondary" && { borderWidth: StyleSheet.hairlineWidth * 2, borderColor: colors.edge },
        (disabled || busy) && { opacity: 0.5 },
        pressed && { opacity: 0.7 },
        style,
      ]}
    >
      {busy ? <ActivityIndicator color={fg} size="small" /> : icon ? <Feather name={icon} size={16} color={fg} /> : null}
      <Text style={{ fontFamily: font.medium, fontSize: 15, color: fg }}>{label}</Text>
    </Pressable>
  );
}

/** A flat list row: hairline between rows, a pressed overlay, no card and no side bar. */
export function Row({ children, onPress, onLongPress, style }: { children: ReactNode; onPress?: () => void; onLongPress?: PressableProps["onLongPress"]; style?: ViewStyle }) {
  const colors = useColors();
  return (
    <Pressable onPress={onPress} onLongPress={onLongPress} delayLongPress={350} style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.selected }, style]}>
      {children}
    </Pressable>
  );
}

export function Separator({ inset = 16 }: { inset?: number }) {
  const colors = useColors();
  return <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.hairline, marginLeft: inset }} />;
}

export function SectionTitle({ children }: { children: ReactNode }) {
  const colors = useColors();
  return <Text style={[typeScale.xs, { fontFamily: font.medium, color: colors.fgSubtle, paddingHorizontal: 16, paddingTop: 20, paddingBottom: 6 }]}>{children}</Text>;
}

/** A small status dot: the only place a color says something about a row. */
export function Dot({ color }: { color: string }) {
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />;
}

export function IconButton({ name, onPress, label, size = 20, color }: { name: IconName; onPress: () => void; label: string; size?: number; color?: string }) {
  const colors = useColors();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} hitSlop={8} onPress={onPress} style={({ pressed }) => [styles.iconButton, pressed && { backgroundColor: colors.selected }]}>
      <Feather name={name} size={size} color={color ?? colors.fg} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: { height: 44, borderRadius: 22, paddingHorizontal: 20, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 12, minHeight: 52 },
  iconButton: { width: 36, height: 36, borderRadius: 18, alignItems: "center", justifyContent: "center" },
});

export interface MenuItem {
  label: string;
  onPress: () => void;
  destructive?: boolean;
}

/** The "…" menu: a native action sheet on iOS (an alert elsewhere), so screens keep one visible action. */
export function showMenu(title: string | undefined, items: MenuItem[]) {
  if (!items.length) return;
  if (Platform.OS === "ios") {
    const destructive = items.findIndex((item) => item.destructive);
    ActionSheetIOS.showActionSheetWithOptions(
      { title, options: [...items.map((item) => item.label), "Cancel"], cancelButtonIndex: items.length, destructiveButtonIndex: destructive === -1 ? undefined : destructive },
      (index) => items[index]?.onPress(),
    );
  } else {
    Alert.alert(title ?? "", undefined, [...items.map((item) => ({ text: item.label, style: item.destructive ? ("destructive" as const) : undefined, onPress: item.onPress })), { text: "Cancel", style: "cancel" }]);
  }
}

/** A native confirm for what can't be undone (land, discard, archive); resolves true on the confirm button. */
export function confirm(title: string, message: string, action: string, destructive = false): Promise<boolean> {
  return new Promise((resolve) =>
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel", onPress: () => resolve(false) },
      { text: action, style: destructive ? "destructive" : "default", onPress: () => resolve(true) },
    ], { cancelable: true, onDismiss: () => resolve(false) }),
  );
}

/** The time now, ticking every `ms` while `active` (elapsed times on working tasks). */
export function useNow(active: boolean, ms = 30_000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [active, ms]);
  return now;
}
