import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import type { Brain, KnowledgeStatus, WikiPageSummary, WikiSearchHit } from "@shared/types";
import { Cell, FieldCell, Footnote, Group, LoadState, SettingsScroll } from "../../components/settings";
import { Icon, type MenuItem, showMenu } from "../../components/ui";
import { api, errorMessage } from "../../lib/api";
import { onDevice } from "../../lib/devices";
import { brainName, brainsOf, pageTree, splitSnippet, type TreeRow } from "../../lib/knowledge";
import { useStore } from "../../lib/store";
import { font, type as typeScale, useColors } from "../../theme";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The Knowledge page (roadmap modules 10 and 11), read-only, as the web's WikiView: the title switches between the
 * agent's notebook, the shared brains it uses and the device's projects; then search, a project's Facts and History,
 * the page tree and each repo's docs. Opened from an agent's "…" (its notebook) or a project's "…" (its knowledge).
 * A paired device's knowledge is read through the signed-in TOT, like its chats.
 */
export default function Knowledge() {
  const colors = useColors();
  const router = useRouter();
  const params = useLocalSearchParams<{ agentId?: string; brainId?: string; deviceId?: string }>();
  const agents = useStore((s) => s.agents);
  const agent = agents.find((a) => a.id === params.agentId) ?? null;
  const device = params.deviceId || agent?.deviceId || null;
  const allProjects = useStore((s) => s.projects);
  const projects = useMemo(() => allProjects.filter((p) => !p.archived && (p.deviceId ?? null) === device), [allProjects, device]);
  const version = useStore((s) => s.knowledgeVersion);

  const [brains, setBrains] = useState<Brain[] | null>(null);
  const [brainId, setBrainId] = useState<string | null>(params.brainId ?? null);
  const [pages, setPages] = useState<WikiPageSummary[] | null>(null);
  const [status, setStatus] = useState<KnowledgeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<WikiSearchHit[] | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const loadBrains = useCallback(async () => {
    try {
      const list = await onDevice(device, () => api.listBrains());
      setBrains(list);
      // Opened from an agent: its notebook.
      setBrainId((id) => id ?? list.find((b) => b.ownerAgentId === agent?.id)?.id ?? null);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [device, agent?.id]);

  useEffect(() => {
    void loadBrains();
  }, [loadBrains]);

  const brain = brains?.find((b) => b.id === brainId) ?? null;
  const project = projects.find((p) => p.brainId === brainId) ?? null;
  const agentNames = agents.filter((a) => (a.deviceId ?? null) === device);
  const name = brain ? (project ? project.name : brainName(brain, agentNames, agent?.id)) : (project?.name ?? "Knowledge");

  // The open brain's pages, and a project's counts; again on any wiki or memory change.
  const load = useCallback(async () => {
    if (!brainId) return;
    try {
      const [list, counts] = await onDevice(device, () =>
        Promise.all([api.listWikiPages(brainId), project ? api.knowledgeStatus(project.id).catch(() => null) : Promise.resolve(null)]),
      );
      setPages(list);
      setStatus(counts);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [brainId, device, project]);

  useEffect(() => {
    void load();
  }, [load, version]);

  useEffect(() => {
    setPages(null);
    setStatus(null);
    setQuery("");
    setCollapsed(new Set());
  }, [brainId]);

  const search = query.trim();
  useEffect(() => {
    if (!brainId || !search) {
      setHits(null);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      onDevice(device, () => api.searchWiki(brainId, search)).then(
        (list) => !cancelled && setHits(list),
        () => !cancelled && setHits([]),
      );
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [brainId, search, device]);

  const switchTo = () => {
    if (!brains) return;
    const projectBrains = new Set(projects.map((p) => p.brainId));
    const mine = agent ? brainsOf(brains, agent.id) : brains.filter((b) => !b.ownerAgentId);
    const items: MenuItem[] = [
      ...mine.filter((b) => !projectBrains.has(b.id)).map((b) => ({ label: brainName(b, agentNames, agent?.id), onPress: () => setBrainId(b.id) })),
      ...projects.filter((p) => brains.some((b) => b.id === p.brainId)).map((p) => ({ label: `Project: ${p.name}`, onPress: () => setBrainId(p.brainId) })),
    ];
    showMenu(agent ? `${agent.name}'s knowledge` : "Knowledge", items);
  };

  const openPage = (id: string) => router.push({ pathname: "/knowledge/page", params: { id, deviceId: device ?? "", agentId: agent?.id ?? "" } });
  const tree = useMemo(() => pageTree(pages ?? [], collapsed), [pages, collapsed]);
  const toggle = (id: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const header = (
    <Stack.Screen
      options={{
        title: "",
        headerTitle: () => (
          <Pressable accessibilityRole="button" accessibilityLabel={`${name}, switch knowledge`} onPress={switchTo} hitSlop={8} style={styles.switcher}>
            <Text numberOfLines={1} style={[typeScale.heading, { color: colors.fg, maxWidth: 220 }]}>
              {name}
            </Text>
            <Icon name="chevron-down" size={16} color={colors.fgSubtle} />
          </Pressable>
        ),
      }}
    />
  );

  if (!brains || (brainId && !pages)) {
    return (
      <SettingsScroll>
        {header}
        <LoadState error={error} onRetry={() => void (brains ? load() : loadBrains())} />
      </SettingsScroll>
    );
  }

  const subtitle = !brain ? "" : brain.kind === "notebook" ? `Private to ${agentNames.find((a) => a.id === brain.ownerAgentId)?.name ?? "its agent"}` : project ? "Project" : brain.allAgents ? "Shared with all agents" : "Shared";
  const row = (page: TreeRow, icon: "file-text" | "folder") => (
    <Pressable
      key={page.id}
      accessibilityRole="button"
      accessibilityLabel={page.title || "Untitled"}
      onPress={() => openPage(page.id)}
      onLongPress={page.hasChildren ? () => toggle(page.id) : undefined}
      style={({ pressed }) => [styles.row, { paddingLeft: 16 + page.depth * 18 }, pressed && { backgroundColor: colors.selected }]}
    >
      <Icon name={page.depth === 0 ? icon : "corner-down-right"} size={16} color={colors.fgSubtle} />
      <View style={{ flex: 1, gap: 1 }}>
        <Text numberOfLines={1} style={[typeScale.body, { color: colors.fg }]}>
          {page.title || "Untitled"}
        </Text>
        {page.summary ? (
          <Text numberOfLines={1} style={[typeScale.ui, { color: colors.fgSubtle }]}>
            {page.summary}
          </Text>
        ) : null}
      </View>
      {page.hasChildren ? (
        <Pressable accessibilityRole="button" accessibilityLabel={collapsed.has(page.id) ? "Expand" : "Collapse"} hitSlop={10} onPress={() => toggle(page.id)}>
          <Icon name={collapsed.has(page.id) ? "chevron-down" : "chevron-up"} size={16} color={colors.fgFaint} />
        </Pressable>
      ) : (
        <Icon name="chevron-right" size={16} color={colors.fgFaint} />
      )}
    </Pressable>
  );

  return (
    <SettingsScroll>
      {header}
      {subtitle ? <Text style={[typeScale.ui, styles.subtitle, { color: colors.fgSubtle }]}>{subtitle}</Text> : null}
      <Group style={{ marginTop: 12 }}>
        <FieldCell value={query} onChangeText={setQuery} placeholder={`Search ${name}`} returnKeyType="search" autoCorrect={false} />
      </Group>

      {search ? (
        <Group title={hits ? plural(hits.length, "page") : "Searching…"}>
          {(hits ?? []).map((hit) => (
            <Cell
              key={hit.id}
              title={hit.title || "Untitled"}
              subtitle={
                <Text numberOfLines={3} style={[typeScale.ui, { color: colors.fgSubtle }]}>
                  {splitSnippet(hit.snippet.replace(/\s+/g, " ")).map((part, i) => (
                    <Text key={i} style={part.marked ? { fontFamily: font.semibold, color: colors.fg } : undefined}>
                      {part.text}
                    </Text>
                  ))}
                </Text>
              }
              chevron
              onPress={() => openPage(hit.id)}
            />
          ))}
          {hits && !hits.length ? <Cell title="No pages match." /> : null}
        </Group>
      ) : (
        <>
          {project ? (
            <Group footer={status ? `${plural(status.facts, "fact")}, loaded in every chat in ${project.name}.` : undefined}>
              <Cell
                title="Facts"
                icon="check-square"
                value={status ? String(status.facts) : undefined}
                chevron
                onPress={() => router.push({ pathname: "/knowledge/facts", params: { projectId: project.id, deviceId: device ?? "" } })}
              />
              <Cell
                title="History"
                icon="clock"
                chevron
                onPress={() => router.push({ pathname: "/knowledge/history", params: { projectId: project.id, deviceId: device ?? "", agentId: agent?.id ?? "" } })}
              />
            </Group>
          ) : null}

          <Group title="Pages" footer={tree.pages.length ? "Agents read and write these as they work. Tap a page to read it; edit them on the computer." : undefined}>
            {tree.pages.map((page) => row(page, "file-text"))}
            {tree.pages.length ? null : <Cell title={brain?.kind === "notebook" ? "Nothing written yet. The agent fills its notebook as it works." : "No pages yet."} />}
          </Group>

          {tree.repos.length ? <Group title="Repos">{tree.repos.map((page) => row(page, "folder"))}</Group> : null}
          {status?.path ? (
            <View style={{ paddingHorizontal: 16 }}>
              <Footnote>Kept as a git repo at {status.path} on the computer.</Footnote>
            </View>
          ) : null}
        </>
      )}
    </SettingsScroll>
  );
}

const styles = StyleSheet.create({
  switcher: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 8, paddingVertical: 4 },
  subtitle: { textAlign: "center", paddingTop: 2 },
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingRight: 16, paddingVertical: 10, minHeight: 48 },
});
