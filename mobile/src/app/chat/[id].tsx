import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { ChatWorkspaceMode, Message } from "@shared/types";
import { MessageView } from "../../components/MessageView";
import { LandCard, PROJECT_ICONS, TaskEmptyState, TaskNotices, TaskStatusIcon, taskActions } from "../../components/tasks";
import { Icon, type IconName, IconButton, Mascot, showMenu } from "../../components/ui";
import { AUTO_MODEL_ID, modelLabel } from "../../lib/models";
import { setFocusedChat } from "../../lib/notify";
import { openModelPicker } from "../../lib/picker";
import { errorMessage } from "../../lib/api";
import { loadConversation, loadModels, sendMessage, setConversationModel, steerTask, stopRun, useStore, watchChat } from "../../lib/store";
import { canPickWorkspace, isSteerable, isTask, isTaskEndingMessage, repoLabel, roleLine, TASK_STATUS_LABELS } from "../../lib/tasks";
import { font, type as typeScale, useColors } from "../../theme";
import { ConnectionBanner, useOffline } from "../../components/ConnectionBanner";

const EMPTY: Message[] = [];

/** A message, or several tasks' "… is done" notices in a row, shown as one compact list. */
type Item = Message | Message[];
const itemKey = (item: Item) => (Array.isArray(item) ? `notices-${item[0]!.id}` : item.id);

const WORKSPACES: { mode: ChatWorkspaceMode; label: string; icon: IconName }[] = [
  { mode: "checkout", label: "Main checkout", icon: "monitor" },
  { mode: "worktree", label: "New worktree", icon: "git-branch" },
];

/**
 * A chat: its messages (newest at the bottom), the reply streaming in live, and the pill composer with Send,
 * or Stop while the agent works. `id` is "new" (with `agentId`, and `projectId` from a project) for a chat
 * that starts with its first message; its composer then picks the project and, in a code project, where it works.
 * A task (a chat with kind "task") adds its status strip, its "…" menu, its empty state and its land card, and
 * its composer adds notes to it while it works ("steering").
 */
export default function Chat() {
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id: string; agentId?: string; projectId?: string }>();
  const [conversationId, setConversationId] = useState<string | null>(params.id === "new" ? null : params.id);
  const conversation = useStore((s) => (conversationId ? s.conversations.find((c) => c.id === conversationId) : undefined));
  const agentId = conversation?.agentId ?? params.agentId;
  const agent = useStore((s) => s.agents.find((a) => a.id === agentId));
  const messages = useStore((s) => (conversationId ? (s.messages[conversationId] ?? EMPTY) : EMPTY));
  const run = useStore((s) => (conversationId ? s.activeRuns[conversationId] : undefined));
  const projects = useStore((s) => s.projects);
  const [loading, setLoading] = useState(Boolean(conversationId));
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  // A new chat's project (none, or one on the agent's device) and, in a code project, where it works.
  const [draftProjectId, setDraftProjectId] = useState<string | null>(params.projectId ?? null);
  const [workspace, setWorkspace] = useState<ChatWorkspaceMode>("checkout");
  // A new chat's model, as the web's draft model: the agent's default until picked.
  const [draftModelId, setDraftModelId] = useState<string | null>(null);
  const models = useStore((s) => (agent?.deviceId ? (s.deviceModels[agent.deviceId] ?? s.models) : s.models));

  // A paired device's agent: its model names come from that device (once), for the header's label.
  const hasDeviceModels = useStore((s) => Boolean(agent?.deviceId && s.deviceModels[agent.deviceId]));
  useEffect(() => {
    if (agent?.deviceId && !hasDeviceModels) void loadModels(agent.deviceId).catch(() => {});
  }, [agent?.deviceId, hasDeviceModels]);

  // The TOT can't be reached: the chat shows what was loaded last, and the composer waits.
  const offline = useOffline();
  const task = isTask(conversation) ? conversation : null;
  const steering = Boolean(task && isSteerable(task.task));

  useEffect(() => {
    if (!conversationId) return;
    const unwatch = watchChat(conversationId);
    loadConversation(conversationId)
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setLoading(false));
    return unwatch;
  }, [conversationId]);

  // The chat on screen gets no notifications about itself (another screen pushed on top doesn't count).
  useFocusEffect(
    useCallback(() => {
      setFocusedChat(conversationId);
      return () => setFocusedChat(null);
    }, [conversationId]),
  );

  // Newest first, for an inverted list that stays pinned to the bottom while the reply streams. Tasks' "… is done"
  // notices in a row read as one compact list, not a message each.
  const items = useMemo(() => {
    const rows: Item[] = [];
    for (const message of messages) {
      const last = rows.at(-1);
      if (!isTaskEndingMessage(message)) rows.push(message);
      else if (Array.isArray(last)) last.push(message);
      else rows.push([message]);
    }
    return rows.reverse();
  }, [messages]);

  const pickable = useMemo(() => projects.filter((p) => !p.archived && p.deviceId === agent?.deviceId), [projects, agent?.deviceId]);
  const draftProject = pickable.find((p) => p.id === draftProjectId) ?? null;

  const send = async () => {
    const body = text.trim();
    if (!body || sending || !agentId || offline) return;
    setSending(true);
    setText("");
    setError(null);
    try {
      if (steering && conversationId) {
        await steerTask(conversationId, body);
      } else {
        const target = conversationId
          ? { conversationId }
          : {
              agentId,
              projectId: draftProject?.id ?? null,
              workspace: draftProject && canPickWorkspace(draftProject) ? workspace : undefined,
              modelId: draftModelId ?? undefined,
            };
        const id = await sendMessage(body, target);
        if (!conversationId) {
          setConversationId(id);
          router.setParams({ id, agentId: undefined, projectId: undefined });
        }
      }
    } catch (e) {
      setText(body);
      setError(errorMessage(e));
    } finally {
      setSending(false);
    }
  };

  const working = Boolean(run);
  // While a task works, typed text is a note for it; with nothing typed, the button stops the turn.
  const showStop = working && !(steering && text.trim());
  const title = conversation?.title || (conversationId ? "" : "New chat");
  const menu = task ? taskActions(task) : [];
  const role = task ? roleLine(task.task.role, task.task.tier) : null;

  const pickProject = () =>
    showMenu("Start this chat in", [
      { label: "No project", onPress: () => setDraftProjectId(null) },
      ...pickable.map((project) => ({ label: project.name, onPress: () => setDraftProjectId(project.id) })),
    ]);
  const pickWorkspace = () => showMenu("Work in", WORKSPACES.map((w) => ({ label: w.label, onPress: () => setWorkspace(w.mode) })));
  const picked = WORKSPACES.find((w) => w.mode === workspace)!;

  // The model menu (module 13): a chat's own model, or a new chat's draft. Tasks pick theirs by role and tier.
  const modelId = conversation?.modelId ?? draftModelId ?? agent?.modelId ?? AUTO_MODEL_ID;
  const canPickModel = Boolean(agent) && !task;
  const pickModel = () =>
    openModelPicker({
      title: "Model",
      deviceId: agent?.deviceId ?? null,
      current: modelId,
      onPick: (id) => (conversation ? void setConversationModel(conversation, id) : setDraftModelId(id)),
    });

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.canvas }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={Platform.OS === "ios" ? insets.top + 44 : 0}>
      <ConnectionBanner />
      <Stack.Screen
        options={{
          headerTitle: () => (
            <Pressable
              accessibilityRole={canPickModel ? "button" : undefined}
              accessibilityLabel={canPickModel ? `Model: ${modelLabel(models, modelId)}. Change model` : undefined}
              disabled={!canPickModel}
              onPress={pickModel}
              style={({ pressed }) => [{ alignItems: "center", maxWidth: 240 }, pressed && { opacity: 0.6 }]}
            >
              <Text numberOfLines={1} style={{ fontFamily: font.semibold, fontSize: 16, color: colors.fg }}>
                {title}
              </Text>
              {agent ? (
                <View style={styles.subtitle}>
                  <Mascot mascot={agent.mascot} size={14} />
                  <Text numberOfLines={1} style={[typeScale.xs, { color: colors.fgSubtle, flexShrink: 1 }]}>
                    {task ? `Task · ${agent.name}` : `${agent.name} · ${modelLabel(models, modelId)}`}
                  </Text>
                  {canPickModel ? <Icon name="chevron-down" size={12} color={colors.fgSubtle} /> : null}
                </View>
              ) : null}
            </Pressable>
          ),
          headerRight: () => (menu.length ? <IconButton name="more-horizontal" label="Task actions" onPress={() => showMenu(task?.title || "Task", menu)} /> : null),
        }}
      />
      {task ? (
        <View style={[styles.taskStrip, { borderBottomColor: colors.hairline }]}>
          <TaskStatusIcon status={task.task.status} size={14} />
          <Text numberOfLines={1} style={[typeScale.xs, { color: task.task.status === "failed" ? colors.danger : colors.fgMuted, flexShrink: 0 }]}>
            {TASK_STATUS_LABELS[task.task.status]}
            {role ? ` · ${role}` : ""}
          </Text>
          {task.task.repo ? (
            <>
              <Icon name="git-branch" size={12} color={colors.fgSubtle} />
              <Text numberOfLines={1} style={[styles.branch, { color: colors.fgSubtle }]}>
                {repoLabel(task.task.repo.source)} · {task.task.repo.branch}
              </Text>
            </>
          ) : null}
        </View>
      ) : null}
      {loading && !messages.length ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.fgSubtle} />
        </View>
      ) : (
        <FlatList
          inverted
          data={items}
          keyExtractor={itemKey}
          contentContainerStyle={styles.list}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) =>
            Array.isArray(item) ? <TaskNotices messages={item} conversationId={conversationId!} /> : <MessageView message={item} streaming={item.id === run?.messageId} />
          }
          ListHeaderComponent={
            <View style={{ gap: 16 }}>
              {working && !run?.messageId ? <Text style={[typeScale.ui, { color: colors.fgSubtle }]}>Starting…</Text> : null}
              {task ? <LandCard task={task} /> : null}
            </View>
          }
          ListEmptyComponent={
            task ? (
              working ? null : (
                <View style={{ transform: [{ scaleY: -1 }] }}>
                  <TaskEmptyState task={task} />
                </View>
              )
            ) : agent ? (
              <View style={[styles.empty, { transform: [{ scaleY: -1 }] }]}>
                <Mascot mascot={agent.mascot} size={48} />
                <Text style={[typeScale.title, { color: colors.fgStrong, textAlign: "center" }]}>
                  {draftProject ? `New chat in ${draftProject.name}` : `What can ${agent.name} do for you?`}
                </Text>
              </View>
            ) : null
          }
        />
      )}
      {error && !offline ? <Text style={[typeScale.sm, { color: colors.danger, paddingHorizontal: 20, paddingBottom: 6 }]}>{error}</Text> : null}
      {!conversationId && agent ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled" contentContainerStyle={styles.pickers} style={{ flexGrow: 0 }}>
          <Picker icon="cpu" label={modelLabel(models, modelId)} onPress={pickModel} />
          {pickable.length > 0 || draftProject ? (
            <Picker icon={draftProject ? PROJECT_ICONS[draftProject.kind] : "message-circle"} label={draftProject?.name ?? "No project"} onPress={pickProject} />
          ) : null}
          {draftProject && canPickWorkspace(draftProject) ? <Picker icon={picked.icon} label={picked.label} onPress={pickWorkspace} /> : null}
        </ScrollView>
      ) : null}
      <View style={[styles.composerWrap, { paddingBottom: Math.max(insets.bottom, 10) }]}>
        <View style={[styles.composer, { backgroundColor: colors.elevated, borderColor: colors.edge }]}>
          <TextInput
            value={text}
            onChangeText={setText}
            editable={!offline}
            placeholder={offline ? "Waiting for the connection…" : steering ? "Add a note for the task" : draftProject && !conversationId ? `New chat in ${draftProject.name}` : agent ? `Message ${agent.name}` : "Message"}
            placeholderTextColor={colors.fgSubtle}
            multiline
            style={[typeScale.chat, styles.input, { color: colors.fg }]}
          />
          {showStop ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Stop" onPress={() => conversationId && void stopRun(conversationId).catch((e) => setError(errorMessage(e)))} style={[styles.send, { backgroundColor: colors.fg }]}>
              {run?.stopping ? <ActivityIndicator size="small" color={colors.canvas} /> : <View style={[styles.stop, { backgroundColor: colors.canvas }]} />}
            </Pressable>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={steering ? "Add note" : "Send"}
              disabled={!text.trim() || sending || offline}
              onPress={() => void send()}
              style={[styles.send, { backgroundColor: text.trim() ? colors.fg : colors.fillStrong }]}
            >
              {sending ? <ActivityIndicator size="small" color={colors.canvas} /> : <Icon name="arrow-up" size={18} color={text.trim() ? colors.canvas : colors.fgSubtle} />}
            </Pressable>
          )}
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

/** A quiet pill above a new chat's composer that opens a native menu (project, workspace). */
function Picker({ icon, label, onPress }: { icon: IconName; label: string; onPress: () => void }) {
  const colors = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.picker, { backgroundColor: pressed ? colors.selected : colors.fill }]}
    >
      <Icon name={icon} size={14} color={colors.fgMuted} />
      <Text numberOfLines={1} style={[typeScale.ui, { fontFamily: font.medium, color: colors.fgMuted, maxWidth: 160 }]}>
        {label}
      </Text>
      <Icon name="chevron-down" size={14} color={colors.fgSubtle} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  list: { paddingHorizontal: 20, paddingVertical: 16, gap: 20, flexGrow: 1 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, paddingVertical: 80 },
  taskStrip: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 16, paddingBottom: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  branch: { fontFamily: font.mono, fontSize: 11, flexShrink: 1 },
  pickers: { flexDirection: "row", gap: 8, paddingHorizontal: 12, paddingTop: 4 },
  subtitle: { flexDirection: "row", alignItems: "center", gap: 4, maxWidth: 240 },
  picker: { flexDirection: "row", alignItems: "center", gap: 6, height: 32, borderRadius: 16, paddingHorizontal: 12 },
  composerWrap: { paddingHorizontal: 12, paddingTop: 6 },
  composer: { flexDirection: "row", alignItems: "flex-end", borderRadius: 26, borderWidth: StyleSheet.hairlineWidth, paddingLeft: 18, paddingRight: 6, paddingVertical: 6, minHeight: 52 },
  input: { flex: 1, maxHeight: 140, paddingTop: 7, paddingBottom: 7 },
  send: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center", marginLeft: 8 },
  stop: { width: 12, height: 12, borderRadius: 2 },
});
