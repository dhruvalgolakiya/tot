import { router } from "expo-router";
import { Alert, Image, Pressable, StyleSheet, Text, useColorScheme, View } from "react-native";
import type { Agent, AgentIsland, MascotSpec } from "@shared/types";
import { errorMessage } from "../lib/api";
import { AGENT_ISLANDS, ISLAND_IMAGES, MASCOT_COLORS } from "../lib/agents";
import { deleteAgent, useStore } from "../lib/store";
import { font, type as typeScale, useColors } from "../theme";
import { confirm, Icon } from "./ui";

/** The four islands as small pictures (dawn in light mode, night in dark), the picked one outlined: the web's IslandPicker. */
export function IslandPicker({ value, onChange }: { value: AgentIsland; onChange: (island: AgentIsland) => void }) {
  const colors = useColors();
  const dawn = useColorScheme() === "light";
  return (
    <View style={styles.islands} accessibilityRole="radiogroup" accessibilityLabel="Island">
      {AGENT_ISLANDS.map((island) => {
        const on = island.id === value;
        return (
          <Pressable
            key={island.id}
            accessibilityRole="radio"
            accessibilityLabel={island.name}
            accessibilityState={{ selected: on }}
            onPress={() => onChange(island.id)}
            style={({ pressed }) => [styles.island, { borderColor: on ? colors.fg : "transparent", opacity: pressed ? 0.7 : 1 }]}
          >
            <View style={[styles.islandFrame, { backgroundColor: colors.fill }]}>
              <Image source={ISLAND_IMAGES[island.id][dawn ? "dawn" : "night"]} style={StyleSheet.absoluteFill} resizeMode="cover" />
            </View>
            <Text numberOfLines={1} style={[typeScale.xs, { color: on ? colors.fg : colors.fgSubtle, fontFamily: on ? font.medium : font.regular, textAlign: "center" }]}>
              {island.name.charAt(0).toUpperCase() + island.name.slice(1)}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** The mascot's color, from the web's twelve swatches; the picked one ringed. */
export function ColorSwatches({ value, onChange }: { value: string; onChange: (color: string) => void }) {
  const colors = useColors();
  return (
    <View style={styles.swatches} accessibilityRole="radiogroup" accessibilityLabel="Color">
      {MASCOT_COLORS.map((color) => {
        const on = color.toLowerCase() === value.toLowerCase();
        return (
          <View key={color} style={styles.swatchSlot}>
            <Pressable
              accessibilityRole="radio"
              accessibilityLabel={color}
              accessibilityState={{ selected: on }}
              hitSlop={4}
              onPress={() => onChange(color)}
              style={[styles.swatchRing, { borderColor: on ? colors.fg : "transparent" }]}
            >
              <View style={[styles.swatch, { backgroundColor: color }]}>{on ? <Icon name="check" size={14} color="#111" /> : null}</View>
            </Pressable>
          </View>
        );
      })}
    </View>
  );
}

/** Whether this agent may be deleted: the TOT keeps at least one agent on each device. */
export function useCanDelete(agent: Agent | undefined): boolean {
  return useStore((s) => (agent ? s.agents.filter((a) => (a.deviceId ?? null) === (agent.deviceId ?? null)).length > 1 : false));
}

/** Confirms, deletes the agent and its chats, and goes back to the agents list. */
export async function confirmDeleteAgent(agent: Agent) {
  if (!(await confirm("Delete agent", `This deletes ${agent.name} and all of its chats. This can't be undone.`, "Delete", true))) return;
  try {
    await deleteAgent(agent);
    if (router.canDismiss()) router.dismissAll();
  } catch (error) {
    Alert.alert("Couldn't delete it", errorMessage(error));
  }
}

/** The new and changed mascot fields, applied over the current spec. */
export const withMascot = (mascot: MascotSpec, change: Partial<MascotSpec>): MascotSpec => ({ ...mascot, ...change });

const styles = StyleSheet.create({
  // Two by two, so each picture is big enough to tell the islands apart.
  islands: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", rowGap: 8, padding: 10 },
  island: { width: "49%", gap: 4, borderRadius: 12, borderWidth: 2, padding: 3, paddingBottom: 6 },
  // The frame sets the size (a square as wide as its slot); the picture fills it, whatever its own size.
  islandFrame: { width: "100%", aspectRatio: 3 / 2, borderRadius: 9, overflow: "hidden" },
  // Two rows of six on any phone width.
  swatches: { flexDirection: "row", flexWrap: "wrap", paddingHorizontal: 8, paddingVertical: 8 },
  swatchSlot: { width: "16.66%", alignItems: "center", paddingVertical: 4 },
  swatchRing: { borderRadius: 20, borderWidth: 2, padding: 2 },
  swatch: { width: 32, height: 32, borderRadius: 16, alignItems: "center", justifyContent: "center" },
});
