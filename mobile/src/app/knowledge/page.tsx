import { Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import type { WikiPage } from "@shared/types";
import { Markdown } from "../../components/Markdown";
import { LoadState } from "../../components/settings";
import { api, errorMessage } from "../../lib/api";
import { onDevice } from "../../lib/devices";
import { agoText } from "../../lib/format";
import { authorText } from "../../lib/knowledge";
import { useStore } from "../../lib/store";
import { type as typeScale, useColors } from "../../theme";

/**
 * One wiki page, read-only: its title, one line, who changed it last, and the page in the app's Markdown (a mermaid
 * diagram shows as its code). Editing is on the computer.
 */
export default function KnowledgePage() {
  const colors = useColors();
  const { id, deviceId, agentId } = useLocalSearchParams<{ id: string; deviceId?: string; agentId?: string }>();
  const agentName = useStore((s) => s.agents.find((a) => a.id === agentId)?.name ?? "an agent");
  const version = useStore((s) => s.knowledgeVersion);
  const [page, setPage] = useState<WikiPage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setPage(await onDevice(deviceId || null, () => api.getWikiPage(id)));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [id, deviceId]);

  useEffect(() => {
    void load();
  }, [load, version]);

  if (!page) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.canvas }}>
        <Stack.Screen options={{ title: "" }} />
        <LoadState error={error} onRetry={() => void load()} />
      </View>
    );
  }

  return (
    <ScrollView style={{ backgroundColor: colors.canvas }} contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      <Stack.Screen options={{ title: "" }} />
      <Text style={[typeScale.title, { color: colors.fgStrong, fontSize: 24, lineHeight: 30 }]}>{page.title || "Untitled"}</Text>
      {page.summary ? <Text style={[typeScale.body, { color: colors.fgMuted, marginTop: 6 }]}>{page.summary}</Text> : null}
      <Text style={[typeScale.xs, { color: colors.fgSubtle, marginTop: 8 }]}>
        {[page.pinned ? "In every chat" : "", `Updated ${agoText(page.updatedAt)} ${authorText(page.updatedBy, agentName)}`].filter(Boolean).join(" · ")}
      </Text>
      <View style={[styles.rule, { backgroundColor: colors.hairline }]} />
      {page.content.trim() ? <Markdown text={page.content} /> : <Text style={[typeScale.body, { color: colors.fgSubtle }]}>This page is empty.</Text>}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 48 },
  rule: { height: StyleSheet.hairlineWidth, marginVertical: 16 },
});
