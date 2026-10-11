import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Message } from "@shared/types";
import { MessageView } from "../../components/MessageView";
import { Icon, Mascot } from "../../components/ui";
import { errorMessage } from "../../lib/api";
import { loadConversation, sendMessage, stopRun, useStore, watchChat } from "../../lib/store";
import { font, type as typeScale, useColors } from "../../theme";

const EMPTY: Message[] = [];

/**
 * A chat: its messages (newest at the bottom), the reply streaming in live, and the pill composer with Send,
 * or Stop while the agent works. `id` is "new" (with `agentId`) for a chat that starts with its first message.
 */
export default function Chat() {
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id: string; agentId?: string }>();
  const [conversationId, setConversationId] = useState<string | null>(params.id === "new" ? null : params.id);
  const conversation = useStore((s) => (conversationId ? s.conversations.find((c) => c.id === conversationId) : undefined));
  const agentId = conversation?.agentId ?? params.agentId;
  const agent = useStore((s) => s.agents.find((a) => a.id === agentId));
  const messages = useStore((s) => (conversationId ? (s.messages[conversationId] ?? EMPTY) : EMPTY));
  const run = useStore((s) => (conversationId ? s.activeRuns[conversationId] : undefined));
  const [loading, setLoading] = useState(Boolean(conversationId));
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!conversationId) return;
    const unwatch = watchChat(conversationId);
    loadConversation(conversationId)
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setLoading(false));
    return unwatch;
  }, [conversationId]);

  // Newest first, for an inverted list that stays pinned to the bottom while the reply streams.
  const reversed = useMemo(() => [...messages].reverse(), [messages]);

  const send = async () => {
    const body = text.trim();
    if (!body || sending || !agentId) return;
    setSending(true);
    setText("");
    setError(null);
    try {
      const id = await sendMessage(body, conversationId ? { conversationId } : { agentId });
      if (!conversationId) {
        setConversationId(id);
        router.setParams({ id, agentId: undefined });
      }
    } catch (e) {
      setText(body);
      setError(errorMessage(e));
    } finally {
      setSending(false);
    }
  };

  const working = Boolean(run);
  const title = conversation?.title || (conversationId ? "" : "New chat");

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.canvas }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={Platform.OS === "ios" ? insets.top + 44 : 0}>
      <Stack.Screen
        options={{
          headerTitle: () => (
            <View style={{ alignItems: "center", maxWidth: 240 }}>
              <Text numberOfLines={1} style={{ fontFamily: font.semibold, fontSize: 16, color: colors.fg }}>
                {title}
              </Text>
              {agent ? <Text style={[typeScale.xs, { color: colors.fgSubtle }]}>{agent.name}</Text> : null}
            </View>
          ),
        }}
      />
      {loading && !messages.length ? (
        <View style={styles.center}>
          <ActivityIndicator color={colors.fgSubtle} />
        </View>
      ) : (
        <FlatList
          inverted
          data={reversed}
          keyExtractor={(m) => m.id}
          contentContainerStyle={styles.list}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => <MessageView message={item} streaming={item.id === run?.messageId} />}
          ListHeaderComponent={working && !run?.messageId ? <Text style={[typeScale.ui, { color: colors.fgSubtle }]}>Starting…</Text> : null}
          ListEmptyComponent={
            agent ? (
              <View style={[styles.empty, { transform: [{ scaleY: -1 }] }]}>
                <Mascot name={agent.name} mascot={agent.mascot} size={48} />
                <Text style={[typeScale.title, { color: colors.fgStrong }]}>What can {agent.name} do for you?</Text>
              </View>
            ) : null
          }
        />
      )}
      {error ? <Text style={[typeScale.sm, { color: colors.danger, paddingHorizontal: 20, paddingBottom: 6 }]}>{error}</Text> : null}
      <View style={[styles.composerWrap, { paddingBottom: Math.max(insets.bottom, 10) }]}>
        <View style={[styles.composer, { backgroundColor: colors.elevated, borderColor: colors.edge }]}>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder={agent ? `Message ${agent.name}` : "Message"}
            placeholderTextColor={colors.fgSubtle}
            multiline
            style={[typeScale.chat, styles.input, { color: colors.fg }]}
          />
          {working ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Stop" onPress={() => conversationId && void stopRun(conversationId).catch((e) => setError(errorMessage(e)))} style={[styles.send, { backgroundColor: colors.fg }]}>
              {run?.stopping ? <ActivityIndicator size="small" color={colors.canvas} /> : <View style={[styles.stop, { backgroundColor: colors.canvas }]} />}
            </Pressable>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Send"
              disabled={!text.trim() || sending}
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

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  list: { paddingHorizontal: 20, paddingVertical: 16, gap: 20, flexGrow: 1 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12, paddingVertical: 80 },
  composerWrap: { paddingHorizontal: 12, paddingTop: 6 },
  composer: { flexDirection: "row", alignItems: "flex-end", borderRadius: 26, borderWidth: StyleSheet.hairlineWidth, paddingLeft: 18, paddingRight: 6, paddingVertical: 6, minHeight: 52 },
  input: { flex: 1, maxHeight: 140, paddingTop: 7, paddingBottom: 7 },
  send: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center", marginLeft: 8 },
  stop: { width: 12, height: 12, borderRadius: 2 },
});
