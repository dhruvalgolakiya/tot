import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Text, View } from "react-native";
import type { Memory, MemoryCommit, MemoryRepoSummary } from "@shared/types";
import { Cell, FieldCell, Footnote, Group, LoadState, SettingsScroll, SwitchCell } from "../../components/settings";
import { confirm, showMenu } from "../../components/ui";
import { api, errorMessage } from "../../lib/api";
import { agoText } from "../../lib/format";
import { commitActor, describeCommit } from "../../lib/memory";
import { saveSettings, useStore } from "../../lib/store";
import { type as typeScale, useColors } from "../../theme";

const REPO = "you";
const PAGE = 8;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
/** Entries keep the day they were written, not the time (the web's MemoryItem shows the same). */
const day = (time: number) =>
  new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric", year: new Date(time).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });

/**
 * Settings → Memory, as the web's (module 10) for the "you" repo: what every agent knows about you (add one and
 * press return, tap one to delete it), Dreaming (on/off, when, Dream now, undo the last one), and the history with
 * Undo. A project's facts are on its Knowledge page, on the computer.
 */
export default function MemorySettings() {
  const colors = useColors();
  const settings = useStore((s) => s.settings);
  const version = useStore((s) => s.memoryVersion);
  const [summary, setSummary] = useState<MemoryRepoSummary | null>(null);
  const [facts, setFacts] = useState<Memory[] | null>(null);
  const [commits, setCommits] = useState<MemoryCommit[] | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [starting, setStarting] = useState(false);
  const [time, setTime] = useState(settings?.memory.dreaming.time ?? "03:30");
  useEffect(() => setTime(settings?.memory.dreaming.time ?? "03:30"), [settings?.memory.dreaming.time]);

  const load = useCallback(async () => {
    try {
      const [repos, files, history] = await Promise.all([api.memoryRepos(), api.memoryFiles(REPO), api.memoryHistory(REPO, limit + 1)]);
      setSummary(repos.find((repo) => repo.kind === "you") ?? null);
      // MEMORY.md (loaded in every chat) first, then the topic files' entries, as the web lists them.
      setFacts(files.filter((file) => file.markdown).flatMap((file) => file.entries));
      setMore(history.length > limit);
      setCommits(history.slice(0, limit));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [limit]);

  useEffect(() => {
    void load();
  }, [load, version]);

  // A dream that changes nothing sends no event: follow it until it's done.
  const dreaming = summary?.dream.running ?? false;
  useEffect(() => {
    if (!dreaming) return;
    const timer = setInterval(() => void load(), 2000);
    return () => clearInterval(timer);
  }, [dreaming, load]);

  const add = async () => {
    const content = draft.trim();
    if (!content || adding) return;
    setAdding(true);
    try {
      await api.createMemory(content, REPO);
      setDraft("");
      await load();
    } catch (e) {
      Alert.alert("Couldn't add it", errorMessage(e));
    } finally {
      setAdding(false);
    }
  };

  const remove = async (memory: Memory) => {
    setFacts((list) => list?.filter((m) => m.id !== memory.id || m.path !== memory.path) ?? null);
    try {
      await api.deleteMemory(memory.id, memory.repo);
    } catch (e) {
      Alert.alert("Couldn't delete it", errorMessage(e));
    }
    await load();
  };

  const undo = async (commit: MemoryCommit, title = "Undo this change?") => {
    const what = `“${describeCommit(commit)}” by ${commitActor(commit)}. A new change puts back what it changed; nothing else is touched.`;
    if (!(await confirm(title, what, "Undo"))) return;
    try {
      await api.revertMemory(REPO, commit.sha);
      await load();
    } catch (e) {
      Alert.alert("Couldn't undo it", errorMessage(e));
    }
  };

  const dreamNow = async () => {
    setStarting(true);
    try {
      await api.dreamMemory(REPO);
      await load();
    } catch (e) {
      Alert.alert("Couldn't start dreaming", errorMessage(e));
    } finally {
      setStarting(false);
    }
  };

  const saveTime = () => {
    if (!settings) return;
    if (!TIME.test(time)) {
      setTime(settings.memory.dreaming.time);
      Alert.alert("Use a 24-hour time", "Like 03:30.");
    } else if (time !== settings.memory.dreaming.time) void saveSettings({ memory: { dreaming: { time } } });
  };

  if (!summary || !facts || !commits) return <SettingsScroll><LoadState error={error} onRetry={() => void load()} /></SettingsScroll>;

  const dream = summary.dream;
  const busy = dream.running || starting;
  const lastDream = commits.find((c) => c.sha === dream.sha);

  return (
    <SettingsScroll>
      {settings && !settings.memory.enabled ? (
        <Group footer="Memory is off, so agents won't save or recall anything.">
          <SwitchCell title="Memory" value={false} onValueChange={(enabled) => void saveSettings({ memory: { enabled } })} />
        </Group>
      ) : null}

      <Group title="About you" footer="One short fact per line. Every agent knows these. Tap one to delete it.">
        <FieldCell
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={() => void add()}
          editable={!adding}
          placeholder="Add something about you, e.g. “I prefer short answers.”"
          returnKeyType="done"
          submitBehavior="submit"
        />
        {facts.map((memory) => (
          <Cell
            key={`${memory.path}:${memory.id}`}
            title={memory.content}
            numberOfLines={6}
            subtitle={[memory.source === "agent" ? "Saved by an agent" : "Added by you", day(memory.createdAt), memory.path === "MEMORY.md" ? "" : memory.path].filter(Boolean).join(" · ")}
            onPress={() => showMenu(memory.content.length > 80 ? `${memory.content.slice(0, 80)}…` : memory.content, [{ label: "Delete", destructive: true, onPress: () => void remove(memory) }])}
          />
        ))}
        {facts.length ? null : <Cell title="Nothing yet. Tell an agent to remember something, or add it above." />}
      </Group>

      {settings ? (
        <Group title="Dreaming" footer="While you sleep, TOT tidies memory: merges duplicates, drops stale entries, settles contradictions. Only memory that changed since the last dream; it uses your Claude or ChatGPT plan's light model. Each night is one change you can undo.">
          <SwitchCell title="Dream every night" value={settings.memory.dreaming.enabled} onValueChange={(enabled) => void saveSettings({ memory: { dreaming: { enabled } } })} />
          <FieldCell
            title="At"
            subtitle="Local time on the computer."
            value={time}
            onChangeText={setTime}
            onEndEditing={saveTime}
            editable={settings.memory.dreaming.enabled}
            keyboardType="numbers-and-punctuation"
            returnKeyType="done"
            maxLength={5}
          />
          <Cell
            title="Last dream about you"
            subtitle={busy ? "Dreaming…" : dream.error ? dream.error : dream.lastAt ? `${dream.summary ?? "Done"} · ${agoText(dream.lastAt)}` : "Not yet."}
            right={busy ? <ActivityIndicator size="small" color={colors.fgSubtle} /> : undefined}
          />
          <Cell title={busy ? "Dreaming…" : "Dream now"} icon="moon" disabled={busy} onPress={() => void dreamNow()} />
          {lastDream?.revertible && !busy ? <Cell title="Undo the last dream" icon="rotate-ccw" onPress={() => void undo(lastDream, "Undo the last dream?")} /> : null}
        </Group>
      ) : null}

      <Group title="History" footer="Every change is a commit. Undo puts back what one changed, as a new change; a sync can't be undone.">
        {commits.map((commit) => (
          <Cell
            key={commit.sha}
            title={describeCommit(commit)}
            subtitle={[commitActor(commit), commit.kind === "start" ? "" : agoText(commit.at), commit.kind !== "start" && commit.added + commit.removed > 0 ? `+${commit.added} −${commit.removed}` : ""]
              .filter(Boolean)
              .join(" · ")}
            right={commit.revertible ? <Text style={[typeScale.sm, { color: colors.fgMuted }]}>Undo</Text> : undefined}
            onPress={commit.revertible ? () => void undo(commit) : undefined}
          />
        ))}
        {more ? <Cell title="Show older changes" onPress={() => setLimit((n) => n + 20)} /> : null}
      </Group>

      <View style={{ paddingHorizontal: 16 }}>
        <Footnote>Kept as a git repo at {summary.path} on the computer.</Footnote>
      </View>
    </SettingsScroll>
  );
}
