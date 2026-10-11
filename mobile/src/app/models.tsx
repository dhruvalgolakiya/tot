import { Stack, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, SectionList, StyleSheet, Text, View } from "react-native";
import type { ModelOption } from "@shared/types";
import { Icon } from "../components/ui";
import { errorMessage } from "../lib/api";
import { displayDescription, displayLabel, groupModels, NO_MODELS } from "../lib/models";
import { modelRequest } from "../lib/picker";
import { loadModels, useStore } from "../lib/store";
import { font, type as typeScale, useColors } from "../theme";


/**
 * The model menu as a native bottom sheet, like the web's header ModelPicker: TOT Auto, then each provider account's
 * models under its name ("Claude", "Claude Mix", "ChatGPT"). Unavailable models are shown with their reason and
 * can't be picked. Picking closes the sheet; what it's for came with openModelPicker.
 */
export default function ModelSheet() {
  const colors = useColors();
  const router = useRouter();
  const [request] = useState(modelRequest);
  const deviceId = request?.deviceId ?? null;
  const models = useStore((s) => (deviceId ? (s.deviceModels[deviceId] ?? NO_MODELS) : s.models));
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Always ask again: accounts get signed in, turned off and renamed on the computer.
  useEffect(() => {
    loadModels(deviceId)
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setLoading(false));
  }, [deviceId]);

  const sections = useMemo(() => {
    const { auto, groups } = groupModels(models);
    return [...(auto.length ? [{ title: "", data: auto }] : []), ...groups.map((group) => ({ title: group.label, data: group.models }))];
  }, [models]);

  const pick = (model: ModelOption) => {
    request?.onPick(model.id);
    router.back();
  };

  // The list is the sheet's root view: a form sheet sizes its first child, and a flex: 1 wrapper there gets no height.
  return (
    <SectionList
      style={{ backgroundColor: colors.canvas }}
      contentInsetAdjustmentBehavior="automatic"
      sections={sections}
      keyExtractor={(model) => model.id}
      stickySectionHeadersEnabled={false}
      contentContainerStyle={{ paddingBottom: 32 }}
      ListHeaderComponent={<Stack.Screen options={{ title: request?.title ?? "Model" }} />}
      ListEmptyComponent={
        <View style={styles.center}>
          {loading ? (
            <ActivityIndicator color={colors.fgSubtle} />
          ) : (
            <Text style={[typeScale.body, { color: colors.fgSubtle, textAlign: "center" }]}>{error ?? "Models aren't available yet. Is the TOT server running?"}</Text>
          )}
        </View>
      }
      renderSectionHeader={({ section }) =>
        section.title ? <Text style={[typeScale.xs, styles.label, { color: colors.fgSubtle, borderTopColor: colors.hairline }]}>{section.title}</Text> : null
      }
      renderItem={({ item }) => {
        const picked = item.id === request?.current;
        const description = item.available ? displayDescription(item) : (item.unavailableReason ?? "Unavailable");
        return (
          <Pressable
            accessibilityRole="radio"
            accessibilityLabel={displayLabel(item)}
            accessibilityState={{ selected: picked, disabled: !item.available }}
            disabled={!item.available}
            onPress={() => pick(item)}
            style={({ pressed }) => [styles.row, pressed && { backgroundColor: colors.selected }, !item.available && { opacity: 0.45 }]}
          >
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={[typeScale.body, { color: colors.fg, fontFamily: picked ? font.medium : font.regular }]}>{displayLabel(item)}</Text>
              {description ? <Text style={[typeScale.xs, { color: colors.fgSubtle }]}>{description}</Text> : null}
            </View>
            {picked ? <Icon name="check" size={18} color={colors.fg} /> : null}
          </Pressable>
        );
      }}
    />
  );
}

const styles = StyleSheet.create({
  center: { alignItems: "center", justifyContent: "center", padding: 48 },
  label: { fontFamily: font.medium, paddingHorizontal: 20, paddingTop: 14, paddingBottom: 4, marginTop: 6, borderTopWidth: StyleSheet.hairlineWidth },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 20, paddingVertical: 10, minHeight: 48 },
});
