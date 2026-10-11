import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useMemo } from "react";
import { ActionSheetIOS, Alert, Platform, SectionList, StyleSheet, Text, View } from "react-native";
import type { Conversation } from "@shared/types";
import { Dot, Icon, IconButton, Mascot, Row, SectionTitle, Separator } from "../../components/ui";
import { errorMessage } from "../../lib/api";
import { ago } from "../../lib/format";
import { deleteConversation, setPinned, useStore } from "../../lib/store";
import { font, type as typeScale, useColors } from "../../theme";

/**
 * An agent's chats, like the web app's sidebar: pinned first, then chats in no project, then a section per
 * project. Tasks show their status. Long-press a chat for Pin and Delete.
 */
export default function AgentChats() {
  const colors = useColors();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const agent = useStore((s) => s.agents.find((a) => a.id === id));
  const conversations = useStore((s) => s.conversations);
  const projects = useStore((s) => s.projects);
  const activeRuns = useStore((s) => s.activeRuns);
  const pendingApprovals = useStore((s) => s.pendingApprovals);
  const device = useStore((s) => (agent?.deviceId ? s.devices?.devices.find((d) => d.id === agent.deviceId) : null));

  const sections = useMemo(() => {
    const mine = conversations.filter((c) => c.agentId === id && !c.parentId).sort((a, b) => b.updatedAt - a.updatedAt);
    const pinned = mine.filter((c) => c.pinned);
    const loose = mine.filter((c) => !c.pinned && !c.projectId);
    const byProject = new Map<string, Conversation[]>();
    for (const c of mine) if (!c.pinned && c.projectId) byProject.set(c.projectId, [...(byProject.get(c.projectId) ?? []), c]);
    const list: { title: string; data: Conversation[] }[] = [];
    if (pinned.length) list.push({ title: "Pinned", data: pinned });
    if (loose.length) list.push({ title: pinned.length || byProject.size ? "Chats" : "", data: loose });
    for (const [projectId, data] of byProject) {
      list.push({ title: projects.find((p) => p.id === projectId)?.name ?? "Project", data });
    }
    return list;
  }, [conversations, projects, id]);

  const more = (conversation: Conversation) => {
    const options = [conversation.pinned ? "Unpin" : "Pin", "Delete", "Cancel"];
    const run = async (index: number) => {
      try {
        if (index === 0) await setPinned(conversation, !conversation.pinned);
        if (index === 1) {
          Alert.alert("Delete this chat?", conversation.title || "Untitled chat", [
            { text: "Cancel", style: "cancel" },
            { text: "Delete", style: "destructive", onPress: () => void deleteConversation(conversation.id).catch((e) => Alert.alert(errorMessage(e))) },
          ]);
        }
      } catch (e) {
        Alert.alert(errorMessage(e));
      }
    };
    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions({ options, destructiveButtonIndex: 1, cancelButtonIndex: 2, title: conversation.title || undefined }, (i) => void run(i));
    } else {
      Alert.alert(conversation.title || "Chat", undefined, [
        { text: options[0], onPress: () => void run(0) },
        { text: "Delete", style: "destructive", onPress: () => void run(1) },
        { text: "Cancel", style: "cancel" },
      ]);
    }
  };

  if (!agent) {
    return (
      <View style={[styles.center, { backgroundColor: colors.canvas }]}>
        <Text style={[typeScale.body, { color: colors.fgSubtle }]}>This agent isn't here anymore.</Text>
      </View>
    );
  }

  const offline = device ? !device.online : false;
  const newChat = () => router.push({ pathname: "/chat/[id]", params: { id: "new", agentId: agent.id } });

  return (
    <View style={{ flex: 1, backgroundColor: colors.canvas }}>
      <Stack.Screen
        options={{
          // The name is in the big header below; the bar stays quiet.
          title: "",
          headerRight: () => (offline ? null : <IconButton name="edit" label="New chat" onPress={newChat} />),
        }}
      />
      <SectionList
        sections={sections}
        keyExtractor={(c) => c.id}
        contentInsetAdjustmentBehavior="automatic"
        stickySectionHeadersEnabled={false}
        ListHeaderComponent={
          <View style={styles.hero}>
            <Mascot name={agent.name} mascot={agent.mascot} size={56} faded={offline} />
            <Text style={[typeScale.title, { color: colors.fgStrong }]}>{agent.name}</Text>
            <Text style={[typeScale.ui, { color: colors.fgSubtle, textAlign: "center" }]}>
              {[agent.tagline, device ? `on ${device.name}${offline ? " · offline" : ""}` : ""].filter(Boolean).join(" · ") || " "}
            </Text>
          </View>
        }
        renderSectionHeader={({ section }) => (section.title ? <SectionTitle>{section.title}</SectionTitle> : null)}
        ItemSeparatorComponent={() => <Separator />}
        renderItem={({ item }) => {
          const working = Boolean(activeRuns[item.id]) || item.task?.status === "running";
          const needsYou = Boolean(pendingApprovals[item.id]) || item.task?.status === "needs-input";
          return (
            <Row onPress={() => router.push({ pathname: "/chat/[id]", params: { id: item.id } })} onLongPress={() => more(item)}>
              {item.kind === "task" ? <Icon name="layers" size={16} color={colors.fgSubtle} /> : item.lead ? <Icon name="compass" size={16} color={colors.fgSubtle} /> : null}
              <Text numberOfLines={1} style={[typeScale.body, { color: colors.fg, flex: 1 }]}>
                {item.title || "New chat"}
              </Text>
              {needsYou ? (
                <Text style={[typeScale.xs, { fontFamily: font.medium, color: colors.warning }]}>Needs you</Text>
              ) : working ? (
                <Dot color={colors.success} />
              ) : null}
              <Text style={[typeScale.xs, { color: colors.fgSubtle, fontVariant: ["tabular-nums"] }]}>{ago(item.updatedAt)}</Text>
            </Row>
          );
        }}
        ListEmptyComponent={
          <Text style={[typeScale.body, { color: colors.fgSubtle, textAlign: "center", padding: 24 }]}>
            {offline ? `${device?.name} is offline. Its chats are safe on it.` : "No chats yet."}
          </Text>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  hero: { alignItems: "center", gap: 6, paddingTop: 12, paddingBottom: 12, paddingHorizontal: 24 },
});
