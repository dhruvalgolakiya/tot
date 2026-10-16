import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import type { MascotSpec } from "@tot/shared/types";
import { ColorSwatches, withMascot } from "../components/agentProfile";
import { Cell, FieldCell, Group, SettingsScroll } from "../components/settings";
import { Mascot } from "../components/ui";
import { errorMessage } from "../lib/api";
import { defaultIsland, NAME_MAX, randomMascot, suggestName } from "../lib/agents";
import { AUTO_MODEL_ID, modelLabel, NO_MODELS } from "../lib/models";
import { openModelPicker } from "../lib/picker";
import { createAgent, loadModels, useStore } from "../lib/store";
import { font, type as typeScale, useColors } from "../theme";

/**
 * A new agent, as the web's New agent dialog in short: a name, the mascot's color (the rest of the mascot is
 * random, as the web starts it), and its default model. `deviceId` makes it on that paired device. Its island is
 * the next one round-robin; the rest is in its settings afterwards.
 */
export default function NewAgent() {
  const colors = useColors();
  const router = useRouter();
  const { deviceId } = useLocalSearchParams<{ deviceId?: string }>();
  const livesOn = deviceId || null;
  const device = useStore((s) => (livesOn ? s.devices?.devices.find((d) => d.id === livesOn) : null));
  const models = useStore((s) => (livesOn ? (s.deviceModels[livesOn] ?? NO_MODELS) : s.models));
  const count = useStore((s) => s.agents.filter((a) => (a.deviceId ?? null) === livesOn).length);
  const [mascot, setMascot] = useState<MascotSpec>(randomMascot);
  const [name, setName] = useState(() => suggestName(mascot));
  const [modelId, setModelId] = useState(AUTO_MODEL_ID);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (livesOn) void loadModels(livesOn).catch(() => {});
  }, [livesOn]);

  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      const agent = await createAgent({ name: trimmed, mascot, island: defaultIsland(count), modelId }, livesOn);
      router.replace({ pathname: "/agent/[id]", params: { id: agent.id } });
    } catch (error) {
      setSaving(false);
      Alert.alert("Couldn't create it", errorMessage(error));
    }
  };

  return (
    <SettingsScroll>
      <Stack.Screen
        options={{
          title: "New agent",
          headerRight: () => (
            <Pressable accessibilityRole="button" disabled={!name.trim() || saving} onPress={() => void create()} hitSlop={8}>
              <Text style={{ fontFamily: font.semibold, fontSize: 16, color: colors.fg, opacity: !name.trim() || saving ? 0.4 : 1 }}>{saving ? "Creating…" : "Create"}</Text>
            </Pressable>
          ),
        }}
      />
      <View style={styles.hero}>
        <Mascot mascot={mascot} size={64} describe />
        {device ? <Text style={[typeScale.ui, { color: colors.fgSubtle }]}>Lives on {device.name}</Text> : null}
      </View>
      <Group>
        <FieldCell title="Name" value={name} onChangeText={setName} maxLength={NAME_MAX} placeholder="e.g. Scout" autoCorrect={false} returnKeyType="done" />
      </Group>
      <Group title="Mascot color">
        <ColorSwatches value={mascot.color} onChange={(color) => setMascot((m) => withMascot(m, { color }))} />
      </Group>
      <Group title="Chats" footer="New chats with this agent start here.">
        <Cell
          title="Default model"
          value={modelLabel(models, modelId)}
          chevron
          onPress={() => openModelPicker({ title: "Default model", deviceId: livesOn, current: modelId, onPick: setModelId })}
        />
      </Group>
    </SettingsScroll>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: "center", gap: 8, paddingTop: 16 },
});
