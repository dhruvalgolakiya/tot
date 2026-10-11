import { Children, Fragment, isValidElement, type ReactNode } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, type TextInputProps, useColorScheme, View, type ViewStyle } from "react-native";
import { font, type as typeScale, useColors } from "../theme";
import { Dot, Icon, type IconName } from "./ui";

/**
 * The settings screens' building blocks, as iOS grouped lists in DESIGN.md's greys: a group (rounded, a shade off
 * the canvas, hairlines between rows), its title above and a footnote below, and rows with a value, a switch, a
 * stepper or a chevron. No colored bars; a status dot is the only color.
 */

export function SettingsScroll({ children }: { children: ReactNode }) {
  const colors = useColors();
  return (
    <ScrollView
      style={{ backgroundColor: colors.canvas }}
      contentInsetAdjustmentBehavior="automatic"
      keyboardDismissMode="interactive"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={styles.scroll}
    >
      {children}
    </ScrollView>
  );
}

export function Group({ title, footer, children, style }: { title?: string; footer?: ReactNode; children: ReactNode; style?: ViewStyle }) {
  const colors = useColors();
  // Separators go between the rows that render (conditional rows leave false/null children).
  const rows = Children.toArray(children).filter((child) => isValidElement(child));
  return (
    <View style={[styles.groupWrap, style]}>
      {title ? <Text style={[typeScale.xs, styles.groupTitle, { color: colors.fgSubtle }]}>{title}</Text> : null}
      {rows.length ? (
        <View style={[styles.group, { backgroundColor: colors.bubble }]}>
          {rows.map((row, i) => (
            <Fragment key={(isValidElement(row) && row.key) || i}>
              {i ? <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.hairline, marginLeft: 16 }} /> : null}
              {row}
            </Fragment>
          ))}
        </View>
      ) : null}
      {footer ? typeof footer === "string" ? <Footnote>{footer}</Footnote> : footer : null}
    </View>
  );
}

export function Footnote({ children, tone }: { children: ReactNode; tone?: "danger" }) {
  const colors = useColors();
  return <Text style={[typeScale.xs, styles.footnote, { color: tone === "danger" ? colors.danger : colors.fgSubtle }]}>{children}</Text>;
}

/**
 * One row: a title (and a line under it), and on the right a value, a control, or a chevron when it opens
 * something. `onPress` makes it a button; `destructive` reads it in the danger color.
 */
export function Cell({
  title,
  subtitle,
  value,
  right,
  icon,
  onPress,
  onLongPress,
  chevron,
  destructive,
  disabled,
  mono,
  numberOfLines = 2,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  value?: ReactNode;
  right?: ReactNode;
  icon?: IconName;
  onPress?: () => void;
  onLongPress?: () => void;
  chevron?: boolean;
  destructive?: boolean;
  disabled?: boolean;
  /** The subtitle is a path or an id. */
  mono?: boolean;
  numberOfLines?: number;
}) {
  const colors = useColors();
  const content = (
    <>
      {icon ? <Icon name={icon} size={18} color={destructive ? colors.danger : colors.fgMuted} /> : null}
      <View style={{ flex: 1, gap: 2 }}>
        {typeof title === "string" ? (
          <Text style={[typeScale.body, { color: destructive ? colors.danger : colors.fg }]} numberOfLines={numberOfLines}>
            {title}
          </Text>
        ) : (
          title
        )}
        {subtitle ? (
          typeof subtitle === "string" ? (
            <Text style={[mono ? styles.mono : typeScale.ui, { color: colors.fgSubtle }]} numberOfLines={mono ? 1 : 4}>
              {subtitle}
            </Text>
          ) : (
            subtitle
          )
        ) : null}
      </View>
      {value !== undefined && value !== null ? (
        typeof value === "string" ? (
          <Text numberOfLines={1} style={[typeScale.sm, { color: colors.fgSubtle, maxWidth: "55%", textAlign: "right" }]}>
            {value}
          </Text>
        ) : (
          value
        )
      ) : null}
      {right}
      {chevron ? <Icon name="chevron-right" size={16} color={colors.fgFaint} /> : null}
    </>
  );
  if (!onPress && !onLongPress) return <View style={[styles.cell, disabled && { opacity: 0.5 }]}>{content}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={typeof title === "string" ? [title, typeof value === "string" ? value : ""].filter(Boolean).join(", ") : undefined}
      disabled={disabled}
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={350}
      style={({ pressed }) => [styles.cell, pressed && { backgroundColor: colors.selected }, disabled && { opacity: 0.5 }]}
    >
      {content}
    </Pressable>
  );
}

/**
 * The web's monochrome Switch on iOS: on is a dark track in light mode and a mid grey in dark mode, so iOS's own white
 * thumb reads on both (iOS 26 doesn't apply a custom thumb color reliably until the switch is toggled), off a quiet fill.
 */
export function Toggle({ value, onValueChange, disabled, label }: { value: boolean; onValueChange: (next: boolean) => void; disabled?: boolean; label: string }) {
  const colors = useColors();
  const dark = useColorScheme() !== "light";
  return (
    <Switch
      accessibilityLabel={label}
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
      trackColor={{ true: dark ? colors.fgSubtle : colors.fg, false: colors.fillStrong }}
      ios_backgroundColor={colors.fillStrong}
    />
  );
}

export function SwitchCell({ title, subtitle, value, onValueChange, disabled }: { title: string; subtitle?: string; value: boolean; onValueChange: (next: boolean) => void; disabled?: boolean }) {
  return <Cell title={title} subtitle={subtitle} right={<Toggle label={title} value={value} onValueChange={onValueChange} disabled={disabled} />} />;
}

/** − value + for a small whole number, like iOS's stepper; each tap saves. */
export function Stepper({ value, min, max, onChange, label }: { value: number; min: number; max: number; onChange: (next: number) => void; label: string }) {
  const colors = useColors();
  const button = (icon: IconName, next: number, disabled: boolean, name: string) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${name} ${label}`}
      disabled={disabled}
      hitSlop={6}
      onPress={() => onChange(next)}
      style={({ pressed }) => [styles.stepButton, { opacity: disabled ? 0.3 : pressed ? 0.6 : 1 }]}
    >
      <Icon name={icon} size={16} color={colors.fg} />
    </Pressable>
  );
  return (
    <View style={[styles.stepper, { backgroundColor: colors.fill }]}>
      {button("minus", value - 1, value <= min, "Fewer")}
      <Text style={[typeScale.body, { fontFamily: font.medium, color: colors.fg, minWidth: 26, textAlign: "center", fontVariant: ["tabular-nums"] }]}>{value}</Text>
      {button("plus", value + 1, value >= max, "More")}
    </View>
  );
}

/** A row of choices, one picked (System / Light / Dark): the picked one filled, like the web's ThemePicker. */
export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string; icon?: IconName }[]; onChange: (next: T) => void; label: string }) {
  const colors = useColors();
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={[styles.segmented, { backgroundColor: colors.fill }]}>
      {options.map((option) => {
        const on = option.value === value;
        return (
          <Pressable
            key={option.value}
            accessibilityRole="radio"
            accessibilityLabel={option.label}
            accessibilityState={{ selected: on }}
            onPress={() => onChange(option.value)}
            style={[styles.segment, on && { backgroundColor: colors.fg }]}
          >
            {option.icon ? <Icon name={option.icon} size={14} color={on ? colors.canvas : colors.fgMuted} /> : null}
            <Text style={[typeScale.ui, { fontFamily: font.medium, color: on ? colors.canvas : colors.fgMuted }]}>{option.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A status as the web's badge: a dot (green for good, amber for a limit, grey otherwise) and a word. */
export function Status({ label, tone, busy }: { label: string; tone: "success" | "warning" | "neutral" | "danger"; busy?: boolean }) {
  const colors = useColors();
  const dot = tone === "success" ? colors.success : tone === "warning" ? colors.warning : tone === "danger" ? colors.danger : colors.fgFaint;
  return (
    <View style={styles.status}>
      {busy ? <ActivityIndicator size="small" color={colors.fgSubtle} /> : <Dot color={dot} />}
      <Text style={[typeScale.ui, { color: colors.fgMuted }]}>{label}</Text>
    </View>
  );
}

/** A small quiet tag beside a name ("Default"). */
export function Tag({ children }: { children: string }) {
  const colors = useColors();
  return (
    <View style={[styles.tag, { backgroundColor: colors.fillStrong }]}>
      <Text style={[typeScale.xs, { fontFamily: font.medium, color: colors.fgMuted }]}>{children}</Text>
    </View>
  );
}

/** A text field as a row (a name, a time, a number of days), saved when editing ends. */
export function FieldCell({ title, subtitle, ...input }: { title?: string; subtitle?: string } & TextInputProps) {
  const colors = useColors();
  const field = (
    <TextInput
      placeholderTextColor={colors.fgFaint}
      clearButtonMode={input.multiline ? "never" : "while-editing"}
      {...input}
      style={[typeScale.body, { color: colors.fg, paddingVertical: 0 }, title ? { textAlign: "right", minWidth: 80, maxWidth: "60%" } : { flex: 1 }, input.multiline && { minHeight: 96, textAlignVertical: "top" }, input.style]}
    />
  );
  if (!title) return <View style={[styles.cell, input.multiline && { alignItems: "flex-start", paddingVertical: 12 }]}>{field}</View>;
  return <Cell title={title} subtitle={subtitle} right={field} />;
}

/** Shown in place of a section's content while it loads, or when it couldn't. */
export function LoadState({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  const colors = useColors();
  if (!error) return <ActivityIndicator style={{ marginTop: 40 }} color={colors.fgSubtle} />;
  return (
    <Group footer={error}>
      <Cell title="Try again" icon="refresh-cw" onPress={onRetry} />
    </Group>
  );
}

const styles = StyleSheet.create({
  scroll: { paddingTop: 8, paddingBottom: 48 },
  groupWrap: { paddingHorizontal: 16, marginTop: 20 },
  groupTitle: { fontFamily: font.medium, paddingHorizontal: 16, paddingBottom: 6, textTransform: "none" },
  group: { borderRadius: 12, overflow: "hidden" },
  footnote: { paddingHorizontal: 16, paddingTop: 6, lineHeight: 17 },
  cell: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 11, minHeight: 48 },
  mono: { fontFamily: font.mono, fontSize: 11, lineHeight: 15 },
  stepper: { flexDirection: "row", alignItems: "center", borderRadius: 16, height: 32, paddingHorizontal: 2 },
  stepButton: { width: 32, height: 32, alignItems: "center", justifyContent: "center" },
  segmented: { flexDirection: "row", borderRadius: 10, padding: 3, gap: 2 },
  segment: { flex: 1, flexDirection: "row", gap: 6, alignItems: "center", justifyContent: "center", height: 32, borderRadius: 8 },
  status: { flexDirection: "row", alignItems: "center", gap: 6 },
  tag: { borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1 },
});
