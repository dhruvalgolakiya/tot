import { Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import type { Agent, AgentInput, ModelOption } from "@tot/shared/types";
import { ColorSwatches, confirmDeleteAgent, IslandPicker, useCanDelete, withMascot } from "../../components/agentProfile";
import { Cell, FieldCell, Footnote, Group, SettingsScroll } from "../../components/settings";
import { Mascot, showMenu } from "../../components/ui";
import { agentIsland, computerLine, islandName, MASCOT_ACCESSORIES, MASCOT_EYES, MASCOT_SHAPES, NAME_MAX, TAGLINE_MAX } from "../../lib/agents";
import { AUTO_MODEL_ID, modelLabel, NO_MODELS } from "../../lib/models";
import { openModelPicker } from "../../lib/picker";
import { loadModels, updateAgent, useStore } from "../../lib/store";
import { type as typeScale, useColors } from "../../theme";

/**
 * An agent's settings, as the web's profile panel (AgentForm), from the "…" on its chats: name, tagline, island,
 * mascot (color, shape, eyes, accessory), instructions, default model, where its computer stands, and Delete.
 * Each change saves as soon as it's made: the phone has no Save button.
 */
export default function AgentSettings() {
  const colors = useColors();
  const { id } = useLocalSearchParams<{ id: string }>();
  const agent = useStore((s) => s.agents.find((a) => a.id === id));
  const models = useStore((s) => (agent?.deviceId ? (s.deviceModels[agent.deviceId] ?? NO_MODELS) : s.models));
  const computerMode = useStore((s) => (agent?.deviceId ? undefined : s.settings?.computer.mode));
  const device = useStore((s) => (agent?.deviceId ? s.devices?.devices.find((d) => d.id === agent.deviceId) : null));
  const canDelete = useCanDelete(agent);

  useEffect(() => {
    if (agent?.deviceId) void loadModels(agent.deviceId).catch(() => {});
  }, [agent?.deviceId]);

  if (!agent) {
    return (
      <View style={[styles.center, { backgroundColor: colors.canvas }]}>
        <Text style={[typeScale.body, { color: colors.fgSubtle }]}>This agent isn't here anymore.</Text>
      </View>
    );
  }
  return <Form agent={agent} models={models} computer={computerLine(agent.computer, computerMode)} deviceName={device?.name ?? null} canDelete={canDelete} />;
}

function Form({ agent, models, computer, deviceName, canDelete }: { agent: Agent; models: ModelOption[]; computer: string; deviceName: string | null; canDelete: boolean }) {
  const colors = useColors();
  // Text fields keep what's typed and save when editing ends; an agent event from elsewhere refills them.
  const [name, setName] = useState(agent.name);
  const [tagline, setTagline] = useState(agent.tagline);
  const [instructions, setInstructions] = useState(agent.instructions);
  useEffect(() => setName(agent.name), [agent.name]);
  useEffect(() => setTagline(agent.tagline), [agent.tagline]);
  useEffect(() => setInstructions(agent.instructions), [agent.instructions]);

  const save = (patch: Partial<AgentInput>) => updateAgent(agent, patch);
  const island = agentIsland(agent);

  const saveName = () => {
    const next = name.trim();
    if (!next) setName(agent.name);
    else if (next !== agent.name) void save({ name: next });
  };
  const saveText = (key: "tagline" | "instructions", value: string) => {
    if (value.trim() !== agent[key]) void save({ [key]: value.trim() });
  };

  const pickFrom = <K extends "shape" | "eyes" | "accessory">(key: K, title: string, labels: Record<string, string>) =>
    showMenu(
      title,
      Object.entries(labels).map(([value, label]) => ({
        label: value === agent.mascot[key] ? `${label} ✓` : label,
        onPress: () => void save({ mascot: withMascot(agent.mascot, { [key]: value }) }),
      })),
    );

  return (
    <SettingsScroll>
      <Stack.Screen options={{ title: `${agent.name} settings` }} />
      <View style={styles.hero}>
        <Mascot mascot={agent.mascot} size={64} describe />
        <Text style={[typeScale.ui, { color: colors.fgSubtle }]}>{[agent.tagline || islandName(island), deviceName ? `on ${deviceName}` : ""].filter(Boolean).join(" · ")}</Text>
      </View>

      <Group title="Profile" footer="The tagline is a few words beside its name. Empty shows its island's name.">
        <FieldCell title="Name" value={name} onChangeText={setName} onEndEditing={saveName} maxLength={NAME_MAX} placeholder="e.g. Scout" autoCorrect={false} returnKeyType="done" />
        <FieldCell
          title="Tagline"
          value={tagline}
          onChangeText={setTagline}
          onEndEditing={() => saveText("tagline", tagline)}
          maxLength={TAGLINE_MAX}
          placeholder={islandName(island)}
          returnKeyType="done"
        />
      </Group>

      <Group title="Island" footer="Where it works from, on your crew page and its Home.">
        <IslandPicker value={island} onChange={(next) => next !== island && void save({ island: next })} />
      </Group>

      <Group title="Mascot">
        <ColorSwatches value={agent.mascot.color} onChange={(color) => void save({ mascot: withMascot(agent.mascot, { color }) })} />
        <Cell title="Shape" value={MASCOT_SHAPES[agent.mascot.shape]} chevron onPress={() => pickFrom("shape", "Shape", MASCOT_SHAPES)} />
        <Cell title="Eyes" value={MASCOT_EYES[agent.mascot.eyes]} chevron onPress={() => pickFrom("eyes", "Eyes", MASCOT_EYES)} />
        <Cell title="Accessory" value={MASCOT_ACCESSORIES[agent.mascot.accessory]} chevron onPress={() => pickFrom("accessory", "Accessory", MASCOT_ACCESSORIES)} />
      </Group>

      <Group title="Instructions" footer="Personality and standing instructions, added to every chat with this agent.">
        <FieldCell
          value={instructions}
          onChangeText={setInstructions}
          onEndEditing={() => saveText("instructions", instructions)}
          multiline
          placeholder="e.g. You're upbeat and concise. Prefer getting things done on the computer over just describing how."
        />
      </Group>

      <Group title="Chats" footer="New chats with this agent start here.">
        <Cell
          title="Default model"
          value={modelLabel(models, agent.modelId || AUTO_MODEL_ID)}
          chevron
          onPress={() =>
            openModelPicker({
              title: "Default model",
              deviceId: agent.deviceId ?? null,
              current: agent.modelId || AUTO_MODEL_ID,
              onPick: (modelId) => modelId !== agent.modelId && void save({ modelId }),
            })
          }
        />
      </Group>

      <Group title="Computer">
        <Cell title={computer} icon="monitor" />
      </Group>

      <Group footer={canDelete ? undefined : <Footnote>You need at least one agent.</Footnote>}>
        <Cell title="Delete agent" destructive disabled={!canDelete} onPress={() => void confirmDeleteAgent(agent)} />
      </Group>
    </SettingsScroll>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  hero: { alignItems: "center", gap: 8, paddingTop: 8 },
});
