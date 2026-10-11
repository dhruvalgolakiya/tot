import { Stack, useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { RefreshControl, SectionList, StyleSheet, Text, View } from "react-native";
import type { Agent, Device } from "@shared/types";
import { Button, Dot, Icon, IconButton, Mascot, Row, SectionTitle, Separator } from "../components/ui";
import { useConnection } from "../lib/connection";
import { loadAll, useStore } from "../lib/store";
import { font, type as typeScale, useColors } from "../theme";

/**
 * Every agent: this TOT's first, then each paired device's (module 07), offline ones faded. A dot while one is
 * working; "Needs you" when one of its chats waits for an approval. Tasks (mission control) is in the header.
 */
export default function Agents() {
  const colors = useColors();
  const router = useRouter();
  const { agents, conversations, devices, loaded, error, runningAgents, pendingApprovals } = useStore();
  const deviceName = useConnection((s) => s.deviceName);
  const [refreshing, setRefreshing] = useState(false);

  const sections = useMemo(() => {
    const paired = devices?.devices ?? [];
    const own = agents.filter((a) => !a.deviceId);
    const list: { device: Device | null; title: string; data: Agent[] }[] = [{ device: null, title: paired.length ? `On ${devices?.self.name ?? deviceName ?? "this TOT"}` : "", data: own }];
    for (const device of paired) {
      list.push({ device, title: `On ${device.name}`, data: agents.filter((a) => a.deviceId === device.id) });
    }
    return list;
  }, [agents, devices, deviceName]);

  const status = (agent: Agent): "needs-you" | "working" | null => {
    const mine = conversations.filter((c) => c.agentId === agent.id);
    if (mine.some((c) => pendingApprovals[c.id] || c.task?.status === "needs-input")) return "needs-you";
    if (runningAgents[agent.id] || mine.some((c) => c.task?.status === "running")) return "working";
    return null;
  };

  const refresh = async () => {
    setRefreshing(true);
    await loadAll();
    setRefreshing(false);
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.canvas }}>
      <Stack.Screen
        options={{
          title: deviceName ?? "Agents",
          headerRight: () => (
            <View style={{ flexDirection: "row", gap: 4 }}>
              <IconButton name="layers" label="Tasks" onPress={() => router.push("/tasks")} />
              <IconButton name="settings" label="Settings" onPress={() => router.push("/settings")} />
            </View>
          ),
        }}
      />
      {!loaded ? null : error && !agents.length ? (
        <View style={styles.empty}>
          <Text style={[typeScale.body, { color: colors.fgMuted, textAlign: "center" }]}>{error}</Text>
          <Button label="Try again" variant="secondary" onPress={() => void refresh()} />
        </View>
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(agent) => agent.id}
          contentInsetAdjustmentBehavior="automatic"
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={colors.fgSubtle} />}
          renderSectionHeader={({ section }) =>
            section.title ? (
              <SectionTitle>
                {section.title}
                {section.device && !section.device.online ? " · offline" : ""}
              </SectionTitle>
            ) : null
          }
          renderSectionFooter={({ section }) =>
            section.device && !section.device.online && !section.data.length ? (
              <Text style={[typeScale.ui, { color: colors.fgSubtle, paddingHorizontal: 16, paddingBottom: 8 }]}>
                {section.device.name} is offline. Its chats are safe on it.
              </Text>
            ) : null
          }
          ItemSeparatorComponent={() => <Separator inset={68} />}
          stickySectionHeadersEnabled={false}
          renderItem={({ item, section }) => {
            const offline = section.device ? !section.device.online : false;
            const state = status(item);
            const chats = conversations.filter((c) => c.agentId === item.id && !c.parentId).length;
            return (
              <Row onPress={() => router.push({ pathname: "/agent/[id]", params: { id: item.id } })}>
                <Mascot name={item.name} mascot={item.mascot} faded={offline} />
                <View style={{ flex: 1, opacity: offline ? 0.5 : 1 }}>
                  <Text numberOfLines={1} style={[typeScale.body, { fontFamily: font.medium, color: colors.fg }]}>
                    {item.name}
                  </Text>
                  <Text numberOfLines={1} style={[typeScale.ui, { color: colors.fgSubtle }]}>
                    {item.tagline || `${chats} ${chats === 1 ? "chat" : "chats"}`}
                  </Text>
                </View>
                {state === "needs-you" ? (
                  <View style={[styles.badge, { backgroundColor: colors.fill }]}>
                    <Dot color={colors.warning} />
                    <Text style={[typeScale.xs, { fontFamily: font.medium, color: colors.fg }]}>Needs you</Text>
                  </View>
                ) : state === "working" ? (
                  <View style={styles.badge}>
                    <Dot color={colors.success} />
                    <Text style={[typeScale.xs, { color: colors.fgSubtle }]}>Working</Text>
                  </View>
                ) : null}
                <Icon name="chevron-right" size={18} color={colors.fgFaint} />
              </Row>
            );
          }}
          ListEmptyComponent={<Text style={[typeScale.body, styles.none, { color: colors.fgSubtle }]}>No agents yet. Make one in TOT on your computer.</Text>}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 32 },
  badge: { flexDirection: "row", alignItems: "center", gap: 6, borderRadius: 12, paddingHorizontal: 8, paddingVertical: 3 },
  none: { textAlign: "center", padding: 32 },
});
