import { Stack } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, RefreshControl, SectionList, StyleSheet, Text, View } from "react-native";
import { MissionRow } from "../components/tasks";
import { Button, Icon, Separator, useNow } from "../components/ui";
import { loadMission, useStore, watchMission } from "../lib/store";
import { boardSections, isTask, type MissionSection, SECTION_TITLES, type TaskConversation } from "../lib/tasks";
import { font, type as typeScale, useColors } from "../theme";
import { ConnectionBanner } from "../components/ConnectionBanner";

/**
 * Mission control (module 09) on the phone: every task from every agent, on this TOT and its paired devices.
 * Needs you first, then what's working, what's ready to land (in the order to land it) and, folded, what landed
 * today. Rows read each task from the store, so their status is live; the board itself is refetched when tasks change.
 */
export default function Tasks() {
  const colors = useColors();
  const mission = useStore((s) => s.mission);
  const conversations = useStore((s) => s.conversations);
  const agents = useStore((s) => s.agents);
  const pendingApprovals = useStore((s) => s.pendingApprovals);
  const devices = useStore((s) => s.devices);
  const [showLanded, setShowLanded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => watchMission(), []);

  const sections = useMemo(() => {
    if (!mission) return null;
    const ids = new Set(mission.taskIds);
    const tasks = conversations.filter((c): c is TaskConversation => ids.has(c.id) && isTask(c));
    return boardSections(tasks, mission.landOrder);
  }, [mission, conversations]);
  const now = useNow(Boolean(sections?.working.length));

  const list = useMemo(() => {
    if (!sections) return [];
    const keys: MissionSection[] = ["needs-you", "working", "ready", "landed"];
    return keys
      .filter((key) => sections[key].length)
      .map((key) => ({ key, title: SECTION_TITLES[key], count: sections[key].length, data: key === "landed" && !showLanded ? [] : sections[key] }));
  }, [sections, showLanded]);

  const summary = sections
    ? [
        sections["needs-you"].length ? `${sections["needs-you"].length} need${sections["needs-you"].length === 1 ? "s" : ""} you` : null,
        sections.working.length ? `${sections.working.length} working` : null,
        sections.ready.length ? `${sections.ready.length} ready to land` : null,
      ]
        .filter(Boolean)
        .join(" · ") || "Nothing in flight"
    : "";

  const refresh = async () => {
    setRefreshing(true);
    await loadMission().catch(() => {});
    setRefreshing(false);
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.canvas }}>
      <ConnectionBanner />
      <Stack.Screen options={{ title: "Tasks" }} />
      {!mission ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.fgSubtle} />
        </View>
      ) : mission.error ? (
        <View style={styles.center}>
          <Text style={[typeScale.body, { color: colors.fgMuted, textAlign: "center" }]}>Couldn't load your tasks. {mission.error}</Text>
          <Button label="Try again" variant="secondary" onPress={() => void refresh()} />
        </View>
      ) : (
        <SectionList
          sections={list}
          keyExtractor={(task) => task.id}
          contentInsetAdjustmentBehavior="automatic"
          stickySectionHeadersEnabled={false}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} tintColor={colors.fgSubtle} />}
          ListHeaderComponent={
            list.length ? (
              <Text style={[typeScale.ui, { color: colors.fgSubtle, paddingHorizontal: 16, paddingTop: 4 }]}>{summary}</Text>
            ) : null
          }
          renderSectionHeader={({ section }) => {
            const landed = section.key === "landed";
            return (
              <Pressable disabled={!landed} onPress={() => setShowLanded(!showLanded)} style={styles.sectionHeader} accessibilityRole={landed ? "button" : undefined}>
                <Text style={[typeScale.xs, { fontFamily: font.medium, color: section.key === "needs-you" ? colors.warning : colors.fgSubtle }]}>
                  {section.title} · {section.count}
                </Text>
                {landed ? <Icon name={showLanded ? "chevron-down" : "chevron-right"} size={13} color={colors.fgSubtle} /> : null}
              </Pressable>
            );
          }}
          renderSectionFooter={({ section }) =>
            section.key === "ready" ? (
              <Text style={[typeScale.xs, { color: colors.fgFaint, paddingHorizontal: 16, paddingTop: 2 }]}>In the order to land them: fewest overlaps first, then the smallest.</Text>
            ) : null
          }
          ItemSeparatorComponent={() => <Separator inset={48} />}
          renderItem={({ item }) => {
            const agent = agents.find((a) => a.id === item.agentId);
            // A paired device's agent says where it lives: the board mixes every device's tasks.
            const device = agent?.deviceId ? devices?.devices.find((d) => d.id === agent.deviceId)?.name : null;
            return <MissionRow task={item} agentName={agent ? (device ? `${agent.name} on ${device}` : agent.name) : null} now={now} waiting={Boolean(pendingApprovals[item.id])} />;
          }}
          ListEmptyComponent={
            <View style={styles.none}>
              <Icon name="layers" size={22} color={colors.fgSubtle} />
              <Text style={[typeScale.heading, { color: colors.fg }]}>No tasks here yet</Text>
              <Text style={[typeScale.ui, { color: colors.fgSubtle, textAlign: "center" }]}>
                Ask for real work in a chat: the agent starts a task when it needs one. Tasks show up here while they work, and until you land them.
              </Text>
            </View>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 32 },
  sectionHeader: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 16, paddingTop: 20, paddingBottom: 6 },
  none: { alignItems: "center", gap: 8, padding: 32, paddingTop: 80 },
});
