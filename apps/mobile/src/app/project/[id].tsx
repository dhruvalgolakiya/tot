import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useMemo, useState } from "react";
import { ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ChatWorkspaceMode } from "@tot/shared/types";
import { PROJECT_ICONS, TaskStatusIcon } from "../../components/tasks";
import { confirm, Dot, Icon, type IconName, IconButton, Row, SectionTitle, Separator, showMenu } from "../../components/ui";
import { errorMessage } from "../../lib/api";
import { ago } from "../../lib/format";
import { archiveProject, openLead, sendMessage, useStore } from "../../lib/store";
import { canPickWorkspace, isTask, sourceLabel } from "../../lib/tasks";
import { font, type as typeScale, useColors } from "../../theme";
import { ConnectionBanner } from "../../components/ConnectionBanner";

const WORKSPACES: { mode: ChatWorkspaceMode; label: string; icon: IconName }[] = [
  { mode: "checkout", label: "Main checkout", icon: "monitor" },
  { mode: "worktree", label: "New worktree", icon: "git-branch" },
];

/**
 * A project's page (module 11), like the web's: its name and source, a composer that starts a new chat in it (with
 * where it works, in a code project: its main checkout or a new worktree), and its chats from every agent, newest
 * first. Its "…" menu starts or opens the project's Lead, and archives it. `agentId` is whose chat the composer starts.
 */
export default function ProjectScreen() {
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id, agentId: agentParam } = useLocalSearchParams<{ id: string; agentId?: string }>();
  const project = useStore((s) => s.projects.find((p) => p.id === id));
  const conversations = useStore((s) => s.conversations);
  const agents = useStore((s) => s.agents);
  const activeRuns = useStore((s) => s.activeRuns);
  const [text, setText] = useState("");
  const [workspace, setWorkspace] = useState<ChatWorkspaceMode>("checkout");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const chats = useMemo(
    () => conversations.filter((c) => c.projectId === id && !(isTask(c) && c.parentId)).sort((a, b) => b.updatedAt - a.updatedAt),
    [conversations, id],
  );
  const lead = chats.find((c) => c.lead);
  // Whose chat the composer starts: the agent it was opened from, else the Lead's, else the device's first agent.
  const agent =
    agents.find((a) => a.id === agentParam) ?? agents.find((a) => a.id === lead?.agentId) ?? agents.find((a) => a.deviceId === project?.deviceId);

  if (!project) {
    return (
      <View style={[styles.center, { backgroundColor: colors.canvas }]}>
        <Stack.Screen options={{ title: "" }} />
        <Text style={[typeScale.body, { color: colors.fgSubtle }]}>This project isn't here anymore.</Text>
      </View>
    );
  }

  const picked = WORKSPACES.find((w) => w.mode === workspace)!;
  const showWorkspace = canPickWorkspace(project);

  const send = async () => {
    const body = text.trim();
    if (!body || sending || !agent) return;
    setSending(true);
    setError(null);
    try {
      const chatId = await sendMessage(body, { agentId: agent.id, projectId: project.id, workspace: showWorkspace ? workspace : undefined });
      setText("");
      router.push({ pathname: "/chat/[id]", params: { id: chatId } });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSending(false);
    }
  };

  const more = () =>
    showMenu(project.name, [
      {
        label: "Knowledge",
        onPress: () => router.push({ pathname: "/knowledge", params: { brainId: project.brainId, deviceId: project.deviceId ?? "", agentId: agent?.id ?? "" } }),
      },
      {
        label: lead ? "Open the Lead" : "Start a Lead",
        onPress: () =>
          void openLead(project.id, agent?.id)
            .then((leadId) => router.push({ pathname: "/chat/[id]", params: { id: leadId } }))
            .catch((e) => Alert.alert(errorMessage(e))),
      },
      {
        label: "Archive",
        destructive: true,
        onPress: async () => {
          if (!(await confirm(`Archive ${project.name}?`, "It leaves the list for every agent. Its chats and its knowledge stay.", "Archive", true))) return;
          try {
            await archiveProject(project.id);
            router.back();
          } catch (e) {
            Alert.alert(errorMessage(e));
          }
        },
      },
    ]);

  const notice =
    project.kind === "folder" && !project.folderGranted ? "Agents can't work in this folder until you allow it in TOT on your computer." : null;

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.canvas }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={Platform.OS === "ios" ? insets.top + 44 : 0}>
      <ConnectionBanner />
      <Stack.Screen options={{ title: "", headerRight: () => <IconButton name="more-horizontal" label="Project options" onPress={more} /> }} />
      <FlatList
        data={chats}
        keyExtractor={(c) => c.id}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="interactive"
        contentInsetAdjustmentBehavior="automatic"
        ListHeaderComponent={
          <View>
            <View style={styles.hero}>
              <Icon name={PROJECT_ICONS[project.kind]} size={24} color={colors.fgMuted} />
              <Text style={[typeScale.title, { color: colors.fgStrong, textAlign: "center" }]}>{project.name}</Text>
              <Text numberOfLines={1} style={[typeScale.ui, { color: colors.fgSubtle, textAlign: "center" }]}>
                {sourceLabel(project)}
              </Text>
            </View>
            {notice ? <Text style={[typeScale.ui, styles.notice, { color: colors.fgMuted, backgroundColor: colors.fill }]}>{notice}</Text> : null}
            <View style={styles.composerWrap}>
              <View style={[styles.composer, { backgroundColor: colors.elevated, borderColor: colors.edge }]}>
                <TextInput
                  value={text}
                  onChangeText={setText}
                  placeholder={`New chat in ${project.name}`}
                  placeholderTextColor={colors.fgSubtle}
                  multiline
                  style={[typeScale.chat, styles.input, { color: colors.fg }]}
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Send"
                  disabled={!text.trim() || sending || !agent}
                  onPress={() => void send()}
                  style={[styles.send, { backgroundColor: text.trim() ? colors.fg : colors.fillStrong }]}
                >
                  {sending ? <ActivityIndicator size="small" color={colors.canvas} /> : <Icon name="arrow-up" size={18} color={text.trim() ? colors.canvas : colors.fgSubtle} />}
                </Pressable>
              </View>
              <View style={styles.pickers}>
                {agent ? <Text style={[typeScale.ui, { color: colors.fgSubtle, paddingHorizontal: 4 }]}>with {agent.name}</Text> : null}
                {showWorkspace ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Works in: ${picked.label}`}
                    onPress={() => showMenu("Work in", WORKSPACES.map((w) => ({ label: w.label, onPress: () => setWorkspace(w.mode) })))}
                    style={({ pressed }) => [styles.picker, { backgroundColor: pressed ? colors.selected : colors.fill }]}
                  >
                    <Icon name={picked.icon} size={14} color={colors.fgMuted} />
                    <Text style={[typeScale.ui, { fontFamily: font.medium, color: colors.fgMuted }]}>{picked.label}</Text>
                    <Icon name="chevron-down" size={14} color={colors.fgSubtle} />
                  </Pressable>
                ) : null}
              </View>
              {error ? <Text style={[typeScale.sm, { color: colors.danger, paddingHorizontal: 4 }]}>{error}</Text> : null}
            </View>
            {chats.length ? <SectionTitle>Chats · {chats.length}</SectionTitle> : null}
          </View>
        }
        ItemSeparatorComponent={() => <Separator />}
        renderItem={({ item }) => {
          const owner = agents.find((a) => a.id === item.agentId);
          return (
            <Row onPress={() => router.push({ pathname: "/chat/[id]", params: { id: item.id } })}>
              {isTask(item) ? (
                <TaskStatusIcon status={item.task.status} />
              ) : item.lead ? (
                <Icon name="compass" size={16} color={colors.fgSubtle} />
              ) : activeRuns[item.id] ? (
                <Dot color={colors.success} />
              ) : null}
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text numberOfLines={1} style={[typeScale.body, { color: colors.fg }]}>
                  {item.title || "New chat"}
                </Text>
                {owner ? (
                  <Text numberOfLines={1} style={[typeScale.xs, { color: colors.fgSubtle }]}>
                    {owner.name}
                  </Text>
                ) : null}
              </View>
              <Text style={[typeScale.xs, { color: colors.fgSubtle, fontVariant: ["tabular-nums"] }]}>{ago(item.updatedAt)}</Text>
            </Row>
          );
        }}
        ListFooterComponent={<View style={{ height: insets.bottom + 24 }} />}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  hero: { alignItems: "center", gap: 6, paddingTop: 16, paddingBottom: 20, paddingHorizontal: 24 },
  notice: { marginHorizontal: 16, marginBottom: 12, borderRadius: 12, padding: 12 },
  composerWrap: { paddingHorizontal: 12, gap: 8 },
  composer: { flexDirection: "row", alignItems: "flex-end", borderRadius: 26, borderWidth: StyleSheet.hairlineWidth, paddingLeft: 18, paddingRight: 6, paddingVertical: 6, minHeight: 52 },
  input: { flex: 1, maxHeight: 140, paddingTop: 7, paddingBottom: 7 },
  send: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center", marginLeft: 8 },
  pickers: { flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" },
  picker: { flexDirection: "row", alignItems: "center", gap: 6, height: 32, borderRadius: 16, paddingHorizontal: 12 },
});
