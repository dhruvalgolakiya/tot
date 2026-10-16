import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Alert, Text } from "react-native";
import type { KnowledgeCommit } from "@shared/types";
import { Cell, Group, LoadState, SettingsScroll } from "../../components/settings";
import { confirm, type MenuItem, showMenu } from "../../components/ui";
import { api, errorMessage } from "../../lib/api";
import { onDevice } from "../../lib/devices";
import { agoText } from "../../lib/format";
import { commitActor, describeCommit } from "../../lib/memory";
import { useStore } from "../../lib/store";
import { type as typeScale, useColors } from "../../theme";

const PAGE = 15;
/** Page titles listed under a change before "+N more". */
const TITLES = 3;

/**
 * A project's knowledge history (the web's KnowledgeHistory): one timeline of its facts and pages, newest first.
 * Tapping a change offers the pages it touched and, when it can be, Undo (a new change that puts it back).
 */
export default function KnowledgeHistory() {
  const colors = useColors();
  const router = useRouter();
  const { projectId, deviceId, agentId } = useLocalSearchParams<{ projectId: string; deviceId?: string; agentId?: string }>();
  const device = deviceId || null;
  const version = useStore((s) => s.knowledgeVersion);
  const [commits, setCommits] = useState<KnowledgeCommit[] | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await onDevice(device, () => api.knowledgeHistory(projectId, limit + 1));
      setMore(list.length > limit);
      setCommits(list.slice(0, limit));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [projectId, device, limit]);

  useEffect(() => {
    void load();
  }, [load, version]);

  const undo = async (commit: KnowledgeCommit) => {
    if (!(await confirm("Undo this change?", `${describeCommit(commit)}, by ${commitActor(commit)}. A new change puts back what it changed; nothing else is touched.`, "Undo"))) return;
    try {
      await onDevice(device, () => api.undoKnowledge(projectId, commit.sha));
      await load();
    } catch (e) {
      // 409: later changes touched the same lines (the server says so).
      Alert.alert("Couldn't undo it", errorMessage(e));
    }
  };

  const openPage = (id: string) => router.push({ pathname: "/knowledge/page", params: { id, deviceId: device ?? "", agentId: agentId ?? "" } });

  const actions = (commit: KnowledgeCommit) => {
    const items: MenuItem[] = [
      ...commit.pages.filter((p) => p.action !== "deleted").slice(0, TITLES).map((p) => ({ label: `Open “${p.title}”`, onPress: () => openPage(p.id) })),
      ...(commit.revertible ? [{ label: "Undo this change", onPress: () => void undo(commit) }] : []),
    ];
    showMenu(describeCommit(commit), items);
  };

  if (!commits) return <SettingsScroll><LoadState error={error} onRetry={() => void load()} /></SettingsScroll>;

  return (
    <SettingsScroll>
      <Group title="Every change" footer="Facts and pages alike, each a commit. Tap one to open its pages or undo it.">
        {commits.map((commit) => {
          const titles = commit.pages.slice(0, TITLES).map((p) => p.title);
          const extra = commit.pages.length > TITLES ? ` +${commit.pages.length - TITLES} more` : "";
          const named = commit.pages.length === 1 && describeCommit(commit).includes(`“${commit.pages[0]!.title}”`);
          const tappable = commit.revertible || commit.pages.some((p) => p.action !== "deleted");
          return (
            <Cell
              key={commit.sha}
              title={describeCommit(commit)}
              subtitle={[
                commitActor(commit),
                // The first commit has the same fixed date on every device: no time for it.
                commit.kind === "start" ? "" : agoText(commit.at),
                commit.kind !== "start" && commit.added + commit.removed > 0 ? `+${commit.added} −${commit.removed}` : "",
                titles.length && !named ? `${titles.join(", ")}${extra}` : "",
              ]
                .filter(Boolean)
                .join(" · ")}
              right={commit.revertible ? <Text style={[typeScale.sm, { color: colors.fgMuted }]}>Undo</Text> : undefined}
              onPress={tappable ? () => actions(commit) : undefined}
            />
          );
        })}
        {commits.length ? null : <Cell title="No changes yet." />}
        {more ? <Cell title="Show older changes" onPress={() => setLimit((n) => n + 20)} /> : null}
      </Group>
    </SettingsScroll>
  );
}
