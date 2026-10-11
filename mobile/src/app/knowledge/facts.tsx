import { useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Alert } from "react-native";
import type { Memory } from "@shared/types";
import { Cell, FieldCell, Group, LoadState, SettingsScroll } from "../../components/settings";
import { showMenu } from "../../components/ui";
import { api, errorMessage } from "../../lib/api";
import { onDevice } from "../../lib/devices";
import { projectMemoryRepo } from "../../lib/knowledge";
import { useStore } from "../../lib/store";

const day = (time: number) =>
  new Date(time).toLocaleDateString(undefined, { month: "short", day: "numeric", year: new Date(time).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });

/**
 * A project's Facts (the web's KnowledgeFacts): its memory entries, loaded at the start of every chat in the
 * project. Small enough to keep on the phone: add one and press return, tap one to delete it.
 */
export default function KnowledgeFacts() {
  const { projectId, deviceId } = useLocalSearchParams<{ projectId: string; deviceId?: string }>();
  const device = deviceId || null;
  const project = useStore((s) => s.projects.find((p) => p.id === projectId));
  const version = useStore((s) => s.knowledgeVersion);
  const [facts, setFacts] = useState<Memory[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const repo = project ? projectMemoryRepo(project.slug) : null;

  const load = useCallback(async () => {
    if (!repo) return;
    try {
      const files = await onDevice(device, () => api.memoryFiles(repo));
      setFacts(files.filter((file) => file.markdown).flatMap((file) => file.entries));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [repo, device]);

  useEffect(() => {
    void load();
  }, [load, version]);

  const add = async () => {
    const content = draft.trim();
    if (!content || adding || !repo) return;
    setAdding(true);
    try {
      await onDevice(device, () => api.createMemory(content, repo));
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
      await onDevice(device, () => api.deleteMemory(memory.id, memory.repo));
    } catch (e) {
      Alert.alert("Couldn't delete it", errorMessage(e));
    }
    await load();
  };

  if (!project) return <SettingsScroll><LoadState error="This project isn't here anymore." onRetry={() => {}} /></SettingsScroll>;
  if (!facts) return <SettingsScroll><LoadState error={error} onRetry={() => void load()} /></SettingsScroll>;

  return (
    <SettingsScroll>
      <Group title={project.name} footer={`Loaded at the start of every chat in ${project.name}. One short fact per line; tap one to delete it.`}>
        <FieldCell
          value={draft}
          onChangeText={setDraft}
          onSubmitEditing={() => void add()}
          editable={!adding}
          placeholder="Add a fact, e.g. “Prices are in cents.”"
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
        {facts.length ? null : <Cell title="No facts yet. Agents save them as they learn the project, or add one above." />}
      </Group>
    </SettingsScroll>
  );
}
