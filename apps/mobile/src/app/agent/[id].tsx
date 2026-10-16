import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useMemo } from "react";
import { ActionSheetIOS, Alert, Platform, Pressable, SectionList, StyleSheet, Text, View } from "react-native";
import type { Conversation, Project } from "@tot/shared/types";
import { PROJECT_ICONS, TaskStatusIcon } from "../../components/tasks";
import { confirmDeleteAgent, useCanDelete } from "../../components/agentProfile";
import { Dot, Icon, IconButton, Mascot, Row, SectionTitle, Separator, showMenu } from "../../components/ui";
import { errorMessage } from "../../lib/api";
import { ago } from "../../lib/format";
import { deleteConversation, setPinned, useStore } from "../../lib/store";
import { font, type as typeScale, useColors } from "../../theme";
import { ConnectionBanner } from "../../components/ConnectionBanner";

/** A section of the list: chats, or (`projects`) the device's projects this agent has no chats in yet. */
type Section = { title: string; project?: Project; data: Conversation[] } | { title: string; projects: Project[]; data: Project[] };

/**
 * An agent's chats, like the web app's sidebar: pinned first, then chats in no project, then a section per
 * project (its title opens the project's page), then the device's other projects. Tasks show their status.
 * Long-press a chat for Pin and Delete.
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
  const canDelete = useCanDelete(agent);

  const sections = useMemo(() => {
    const mine = conversations.filter((c) => c.agentId === id && !c.parentId).sort((a, b) => b.updatedAt - a.updatedAt);
    const pinned = mine.filter((c) => c.pinned);
    const loose = mine.filter((c) => !c.pinned && !c.projectId);
    const byProject = new Map<string, Conversation[]>();
    for (const c of mine) if (!c.pinned && c.projectId) byProject.set(c.projectId, [...(byProject.get(c.projectId) ?? []), c]);
    const list: Section[] = [];
    if (pinned.length) list.push({ title: "Pinned", data: pinned });
    if (loose.length) list.push({ title: pinned.length || byProject.size ? "Chats" : "", data: loose });
    for (const [projectId, data] of byProject) {
      const project = projects.find((p) => p.id === projectId);
      list.push({ title: project?.name ?? "Project", project, data });
    }
    // Projects live on a device and are shared by its agents: the ones this agent hasn't worked in yet are one tap away too.
    const others = projects.filter((p) => !p.archived && p.deviceId === agent?.deviceId && !byProject.has(p.id));
    if (others.length) list.push({ title: "Projects", projects: others, data: others });
    return list;
  }, [conversations, projects, id, agent?.deviceId]);

  const openProject = (projectId: string) => router.push({ pathname: "/project/[id]", params: { id: projectId, agentId: id } });

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
      <ConnectionBanner />
      <Stack.Screen
        options={{
          // The name is in the big header below; the bar stays quiet.
          title: "",
          headerRight: () => (
            <View style={{ flexDirection: "row", gap: 4 }}>
              {offline ? null : <IconButton name="edit" label="New chat" onPress={newChat} />}
              {offline ? null : (
                <IconButton
                  name="more-horizontal"
                  label="Agent options"
                  onPress={() =>
                    showMenu(agent.name, [
                      { label: "Knowledge", onPress: () => router.push({ pathname: "/knowledge", params: { agentId: agent.id } }) },
                      { label: "Agent settings", onPress: () => router.push({ pathname: "/agent-settings/[id]", params: { id: agent.id } }) },
                      ...(canDelete ? [{ label: "Delete agent…", destructive: true, onPress: () => void confirmDeleteAgent(agent) }] : []),
                    ])
                  }
                />
              )}
            </View>
          ),
        }}
      />
      <SectionList<Conversation | Project, Section>
        sections={sections}
        keyExtractor={(item) => item.id}
        contentInsetAdjustmentBehavior="automatic"
        stickySectionHeadersEnabled={false}
        ListHeaderComponent={
          <View style={styles.hero}>
            <Mascot mascot={agent.mascot} size={56} faded={offline} sleeping={offline} />
            <Text style={[typeScale.title, { color: colors.fgStrong }]}>{agent.name}</Text>
            <Text style={[typeScale.ui, { color: colors.fgSubtle, textAlign: "center" }]}>
              {[agent.tagline, device ? `on ${device.name}${offline ? " · offline" : ""}` : ""].filter(Boolean).join(" · ") || " "}
            </Text>
          </View>
        }
        renderSectionHeader={({ section }) =>
          "project" in section && section.project ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open ${section.title}`}
              onPress={() => openProject(section.project!.id)}
              style={({ pressed }) => [styles.projectHeader, pressed && { opacity: 0.6 }]}
            >
              <Icon name={PROJECT_ICONS[section.project.kind]} size={12} color={colors.fgSubtle} />
              <Text numberOfLines={1} style={[typeScale.xs, { fontFamily: font.medium, color: colors.fgSubtle, flexShrink: 1 }]}>
                {section.title}
              </Text>
              <Icon name="chevron-right" size={12} color={colors.fgFaint} />
            </Pressable>
          ) : section.title ? (
            <SectionTitle>{section.title}</SectionTitle>
          ) : null
        }
        ItemSeparatorComponent={() => <Separator />}
        renderItem={({ item, section }) => {
          if ("projects" in section) {
            const project = item as Project;
            return (
              <Row onPress={() => openProject(project.id)}>
                <Icon name={PROJECT_ICONS[project.kind]} size={16} color={colors.fgSubtle} />
                <Text numberOfLines={1} style={[typeScale.body, { color: colors.fg, flex: 1 }]}>
                  {project.name}
                </Text>
                <Icon name="chevron-right" size={16} color={colors.fgFaint} />
              </Row>
            );
          }
          const chat = item as Conversation;
          const working = Boolean(activeRuns[chat.id]);
          const needsYou = Boolean(pendingApprovals[chat.id]) || chat.task?.status === "needs-input";
          return (
            <Row onPress={() => router.push({ pathname: "/chat/[id]", params: { id: chat.id } })} onLongPress={() => more(chat)}>
              {chat.task ? <TaskStatusIcon status={chat.task.status} /> : chat.lead ? <Icon name="compass" size={16} color={colors.fgSubtle} /> : null}
              <Text numberOfLines={1} style={[typeScale.body, { color: colors.fg, flex: 1 }]}>
                {chat.title || "New chat"}
              </Text>
              {needsYou ? (
                <Text style={[typeScale.xs, { fontFamily: font.medium, color: colors.warning }]}>Needs you</Text>
              ) : working && !chat.task ? (
                <Dot color={colors.success} />
              ) : null}
              <Text style={[typeScale.xs, { color: colors.fgSubtle, fontVariant: ["tabular-nums"] }]}>{ago(chat.updatedAt)}</Text>
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
  projectHeader: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 16, paddingTop: 20, paddingBottom: 6 },
});
