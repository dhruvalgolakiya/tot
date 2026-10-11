import { Stack, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import type { TaskChanges, TaskPlan } from "@shared/types";
import { Markdown } from "../../components/Markdown";
import { Segmented } from "../../components/settings";
import { Icon } from "../../components/ui";
import { api, errorMessage } from "../../lib/api";
import { useStore } from "../../lib/store";
import { isTask } from "../../lib/tasks";
import { font, type as typeScale, useColors } from "../../theme";

type Tab = "plan" | "changes";

/** Past this many diff lines the phone shows the file list and says the rest is on the computer: a Text this long stalls. */
const MAX_DIFF_LINES = 1500;

/**
 * A task's Plan and Changes, read-only, as the web's task tabs: its checklist and PLAN.md (from the agent's
 * computer), and for a coding task the files its branch changed against the base with the diff. Opened from the
 * task's "…". Pull to refresh.
 */
export default function TaskDetail() {
  const colors = useColors();
  const params = useLocalSearchParams<{ id: string; view?: Tab }>();
  const task = useStore((s) => s.conversations.find((c) => c.id === params.id));
  const [view, setView] = useState<Tab>(params.view === "changes" ? "changes" : "plan");
  const [plan, setPlan] = useState<TaskPlan | null>(null);
  const [changes, setChanges] = useState<TaskChanges | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const hasRepo = Boolean(isTask(task) && task.task.repo);

  const load = useCallback(async () => {
    setError(null);
    try {
      if (view === "plan") setPlan(await api.taskPlan(params.id));
      else setChanges(await api.taskChanges(params.id));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, [view, params.id]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  const checklist = isTask(task) ? task.task.plan : [];

  return (
    <View style={{ flex: 1, backgroundColor: colors.canvas }}>
      <Stack.Screen options={{ title: task?.title || "Task" }} />
      {hasRepo ? (
        <View style={styles.switcher}>
          <Segmented
            label="Show"
            value={view}
            onChange={setView}
            options={[
              { value: "plan", label: "Plan" },
              { value: "changes", label: "Changes" },
            ]}
          />
        </View>
      ) : null}
      <ScrollView contentContainerStyle={styles.page} refreshControl={<RefreshControl refreshing={false} onRefresh={() => void load()} tintColor={colors.fgSubtle} />}>
        {loading ? <ActivityIndicator color={colors.fgSubtle} style={{ marginTop: 32 }} /> : null}
        {error ? <Text style={[typeScale.sm, { color: colors.danger }]}>{error}</Text> : null}
        {view === "plan" && !loading ? (
          <>
            {checklist.length ? (
              <View style={{ gap: 8 }}>
                {checklist.map((item, i) => (
                  <View key={i} style={styles.check} accessible accessibilityLabel={`${item.done ? "Done" : "To do"}: ${item.text}`}>
                    <Icon name={item.done ? "check-circle" : "circle"} size={16} color={item.done ? colors.success : colors.fgSubtle} />
                    <Text style={[typeScale.sm, { flex: 1, color: item.done ? colors.fgSubtle : colors.fg }]}>{item.text}</Text>
                  </View>
                ))}
              </View>
            ) : null}
            {plan?.content ? (
              <View style={{ gap: 8 }}>
                <Text style={[styles.path, { color: colors.fgSubtle }]}>{plan.path}</Text>
                <Markdown text={plan.content} />
              </View>
            ) : plan ? (
              <Text style={[typeScale.sm, { color: colors.fgSubtle }]}>{plan.reason ?? "No plan written yet."}</Text>
            ) : null}
          </>
        ) : null}
        {view === "changes" && !loading && changes ? <Changes changes={changes} /> : null}
      </ScrollView>
    </View>
  );
}

function Changes({ changes }: { changes: TaskChanges }) {
  const colors = useColors();
  const lines = changes.patch.split("\n");
  const shown = lines.slice(0, MAX_DIFF_LINES);
  const added = changes.files.reduce((n, f) => n + f.additions, 0);
  const removed = changes.files.reduce((n, f) => n + f.deletions, 0);
  return (
    <View style={{ gap: 16 }}>
      <Text style={[typeScale.ui, { color: colors.fgMuted }]}>
        {changes.branch} → {changes.baseBranch} · {changes.files.length} {changes.files.length === 1 ? "file" : "files"} · +{added} −{removed}
      </Text>
      {changes.files.length ? (
        <View style={[styles.files, { borderColor: colors.hairline }]}>
          {changes.files.map((file) => (
            <View key={file.path} style={[styles.file, { borderBottomColor: colors.hairline }]}>
              <Text numberOfLines={1} style={[styles.mono, { flex: 1, color: colors.fg }]}>
                {file.path}
              </Text>
              <Text style={[styles.mono, { color: colors.success }]}>+{file.additions}</Text>
              <Text style={[styles.mono, { color: colors.danger }]}>−{file.deletions}</Text>
            </View>
          ))}
        </View>
      ) : (
        <Text style={[typeScale.sm, { color: colors.fgSubtle }]}>No changes on its branch yet.</Text>
      )}
      {changes.patch ? (
        <ScrollView horizontal style={[styles.diff, { backgroundColor: colors.codeBg }]} contentContainerStyle={{ padding: 12 }}>
          <Text selectable style={[styles.mono, { color: colors.fg }]}>
            {shown.map((line, i) => (
              <Text key={i} style={{ color: lineColor(line, colors) }}>
                {line}
                {"\n"}
              </Text>
            ))}
          </Text>
        </ScrollView>
      ) : null}
      {changes.truncated || lines.length > MAX_DIFF_LINES ? (
        <Text style={[typeScale.xs, { color: colors.fgSubtle }]}>The diff is long; the rest is in TOT on the computer.</Text>
      ) : null}
    </View>
  );
}

function lineColor(line: string, colors: ReturnType<typeof useColors>): string {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) return colors.fgSubtle;
  if (line.startsWith("@@")) return colors.link;
  if (line.startsWith("+")) return colors.success;
  if (line.startsWith("-")) return colors.danger;
  return colors.fgMuted;
}

const styles = StyleSheet.create({
  switcher: { paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 },
  page: { padding: 16, gap: 20, paddingBottom: 48 },
  check: { flexDirection: "row", gap: 10, alignItems: "flex-start" },
  path: { fontFamily: font.mono, fontSize: 11 },
  mono: { fontFamily: font.mono, fontSize: 12, lineHeight: 18 },
  files: { borderTopWidth: StyleSheet.hairlineWidth },
  file: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
  diff: { borderRadius: 10 },
});
