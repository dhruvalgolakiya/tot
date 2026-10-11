import { router, useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from "react-native";
import type { Message, Project, TaskChecks, TaskLandOptions, TaskStatus } from "@shared/types";
import { errorMessage, api } from "../lib/api";
import { discardTask, landTask, pauseTask, resumeTask, runTaskNow, stopTask, useStore } from "../lib/store";
import {
  canPause,
  canResume,
  CHECKS_LABELS,
  groupSummary,
  isOpenTask,
  isReadyToLand,
  isTask,
  isTaskEndingNotice,
  landingLine,
  readEnding,
  roleLine,
  statsLine,
  TASK_STATUS_LABELS,
  taskElapsed,
  taskLine,
  taskState,
  taskStatusLine,
  type TaskConversation,
} from "../lib/tasks";
import { font, type as typeScale, useColors } from "../theme";
import { Button, confirm, Icon, type IconName, type MenuItem, showMenu, useNow } from "./ui";

/**
 * Tasks in the app (module 09 on a phone): their status icon, the rows the web app's task group card and mission
 * control show, the compact "… is done" notes, a task's empty state, and the land card of a finished coding task.
 * Status is a small grey icon; only failed (red) and needs-you (amber) take a color.
 */

/** A project's icon by kind, as on the web (lucide FolderGit / Folder / Layers). */
export const PROJECT_ICONS: Record<Project["kind"], IconName> = { github: "github", folder: "folder", none: "layers" };

const STATUS_ICONS: Record<TaskStatus, IconName> = {
  queued: "clock",
  running: "loader",
  "needs-input": "alert-circle",
  paused: "pause-circle",
  done: "check-circle",
  failed: "x-circle",
  stopped: "stop-circle",
  interrupted: "pause-circle",
};

export function TaskStatusIcon({ status, size = 16 }: { status: TaskStatus; size?: number }) {
  const colors = useColors();
  if (status === "running") {
    return (
      <View accessibilityLabel={TASK_STATUS_LABELS[status]} style={[styles.iconBox, { width: size + 4, height: size + 4 }]}>
        <ActivityIndicator size="small" color={colors.fgSubtle} style={{ transform: [{ scale: size / 20 }] }} />
      </View>
    );
  }
  const color = status === "failed" ? colors.danger : status === "needs-input" || status === "interrupted" ? colors.warning : colors.fgSubtle;
  return (
    <View accessibilityLabel={TASK_STATUS_LABELS[status]} style={[styles.iconBox, { width: size + 4, height: size + 4 }]}>
      <Icon name={STATUS_ICONS[status]} size={size} color={color} />
    </View>
  );
}

/** Run now, Pause, Resume, Stop: what a task can do next, for its "…" menu or a row's long-press. */
export function taskActions(task: TaskConversation): MenuItem[] {
  const { status } = task.task;
  const run = (action: (id: string) => Promise<unknown>) => () => void action(task.id).catch((e) => Alert.alert(errorMessage(e)));
  const items: MenuItem[] = [];
  if (status === "queued") items.push({ label: "Run now", onPress: run(runTaskNow) });
  if (canResume(status)) items.push({ label: "Resume", onPress: run(resumeTask) });
  if (canPause(status)) items.push({ label: "Pause", onPress: run(pauseTask) });
  if (isOpenTask(status)) items.push({ label: "Stop", destructive: true, onPress: run(stopTask) });
  // Read-only views of what it's doing: its plan, and for a coding task its branch's changes.
  items.push({ label: "Plan", onPress: () => router.push({ pathname: "/task-detail/[id]", params: { id: task.id, view: "plan" } }) });
  if (task.task.repo) items.push({ label: "Changes", onPress: () => router.push({ pathname: "/task-detail/[id]", params: { id: task.id, view: "changes" } }) });
  return items;
}

export function openTaskMenu(task: TaskConversation) {
  showMenu(task.title || "Task", taskActions(task));
}

/** One task in a group card: status icon, title, one muted line (role · tier · progress), and how long it's run. */
function TaskGroupRow({ task, now }: { task: TaskConversation; now: number }) {
  const colors = useColors();
  const router = useRouter();
  const elapsed = taskElapsed(task.task, now);
  const line = [roleLine(task.task.role, task.task.tier), taskLine(task.task)].filter(Boolean).join(" · ");
  return (
    <Pressable
      onPress={() => router.push({ pathname: "/chat/[id]", params: { id: task.id } })}
      onLongPress={() => openTaskMenu(task)}
      delayLongPress={350}
      style={({ pressed }) => [styles.groupRow, pressed && { backgroundColor: colors.selected }]}
    >
      <TaskStatusIcon status={task.task.status} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={1} style={[typeScale.ui, { color: colors.fg }]}>
          {task.title || "Task"}
        </Text>
        {line ? (
          <Text numberOfLines={1} style={[typeScale.xs, { color: colors.fgSubtle }]}>
            {line}
          </Text>
        ) : null}
      </View>
      {elapsed ? <Text style={[typeScale.xs, { color: colors.fgSubtle, fontVariant: ["tabular-nums"] }]}>{elapsed}</Text> : null}
    </Pressable>
  );
}

/**
 * Tasks a chat started together, stacked into one card: "6 tasks · 4 done · 2 paused", a row each (tap opens it,
 * long-press for Pause / Resume / Stop). A single task gets the same card without the header.
 */
export function TaskGroupCard({ taskIds }: { taskIds: string[] }) {
  const colors = useColors();
  const [open, setOpen] = useState(true);
  const all = useStore((s) => s.conversations);
  const group = taskIds.map((id) => all.find((c) => c.id === id)).filter(isTask);
  const now = useNow(group.some((task) => task.task.status === "running"));
  if (!group.length) return null;
  const combining = group.some((task) => isOpenTask(task.task.status)) && group.some((task) => task.task.then === "synthesize");
  return (
    <View style={[styles.card, { borderColor: colors.hairline }]}>
      {taskIds.length > 1 ? (
        <Pressable onPress={() => setOpen(!open)} style={styles.groupHeader} accessibilityRole="button" accessibilityState={{ expanded: open }}>
          <Icon name={open ? "chevron-down" : "chevron-right"} size={14} color={colors.fgSubtle} />
          <Text numberOfLines={2} style={[typeScale.ui, { fontFamily: font.medium, color: colors.fg, flexShrink: 1, fontVariant: ["tabular-nums"] }]}>
            {groupSummary(group)}
          </Text>
          {combining ? (
            <Text numberOfLines={1} style={[typeScale.xs, { color: colors.fgSubtle, flexShrink: 1 }]}>
              · combined here when done
            </Text>
          ) : null}
        </Pressable>
      ) : null}
      {open || taskIds.length === 1 ? group.map((task) => <TaskGroupRow key={task.id} task={task} now={now} />) : null}
    </View>
  );
}

/** The tasks a chat started, as they finish: one quiet line each, stacked however many messages they came in. */
export function TaskNotices({ messages, conversationId }: { messages: Message[]; conversationId: string }) {
  const colors = useColors();
  const router = useRouter();
  const all = useStore((s) => s.conversations);
  const notices = messages.flatMap((message) => message.parts.filter(isTaskEndingNotice));
  return (
    <View>
      {notices.map((notice) => {
        const { title, status, result } = readEnding(notice);
        // Older notices carry no task id: find the task by its title among this chat's tasks.
        const task = all.find((c) => c.id === notice.taskId) ?? all.find((c) => isTask(c) && c.parentId === conversationId && c.title === title);
        return (
          <Pressable
            key={notice.id}
            disabled={!task}
            onPress={() => task && router.push({ pathname: "/chat/[id]", params: { id: task.id } })}
            style={({ pressed }) => [styles.notice, pressed && { backgroundColor: colors.selected }]}
          >
            <TaskStatusIcon status={status} size={14} />
            <Text numberOfLines={1} style={[typeScale.ui, { flex: 1, color: colors.fgMuted }]}>
              {task?.title ?? title}
              {result ? <Text style={{ color: colors.fgSubtle }}> · {result}</Text> : null}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** A task with nothing in it yet (queued, paused before it started, about to reply): what it was asked, and where it is. */
export function TaskEmptyState({ task }: { task: TaskConversation }) {
  const colors = useColors();
  const [expanded, setExpanded] = useState(false);
  const [long, setLong] = useState(false);
  const queueHeld = useStore((s) => Boolean(s.agents.find((agent) => agent.id === task.agentId)?.queueHold));
  const goal = (task.task.brief?.goal ?? task.task.goal).trim();
  const state = taskState(task, queueHeld);
  return (
    <View style={styles.empty}>
      {goal ? (
        <View style={{ gap: 6 }}>
          <Text style={[typeScale.xs, { color: colors.fgSubtle }]}>Asked to</Text>
          <Text
            numberOfLines={expanded ? undefined : 5}
            onTextLayout={(e) => !expanded && setLong(e.nativeEvent.lines.length >= 5)}
            style={[typeScale.sm, { color: colors.fgMuted }]}
          >
            {goal}
          </Text>
          {long ? (
            <Pressable onPress={() => setExpanded(!expanded)} hitSlop={6}>
              <Text style={[typeScale.xs, { color: colors.fgSubtle, textDecorationLine: "underline" }]}>{expanded ? "Show less" : "Show all"}</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      <View style={styles.stateLine}>
        <TaskStatusIcon status={task.task.status} />
        <Text style={[typeScale.ui, { color: colors.fgMuted, flex: 1 }]}>
          {state.text}
          {state.resumable ? (
            <Text onPress={() => void resumeTask(task.id).catch((e) => Alert.alert(errorMessage(e)))} style={{ color: colors.fg, fontFamily: font.medium }}>
              {"   "}Resume
            </Text>
          ) : null}
        </Text>
      </View>
    </View>
  );
}

const CHECK_ICONS: Record<TaskChecks["state"], IconName> = {
  running: "loader",
  passing: "check-circle",
  failing: "x-circle",
  none: "minus-circle",
};

/** A task's checks as one small icon: grey, red when they fail. */
export function ChecksIcon({ checks, size = 13 }: { checks: TaskChecks; size?: number }) {
  const colors = useColors();
  return <Icon name={CHECK_ICONS[checks.state]} size={size} color={checks.state === "failing" ? colors.danger : colors.fgSubtle} />;
}

/**
 * The bottom of a finished coding task: its changes, its checks, how far its base moved on, and Land (merge into the
 * folder's branch, or a draft PR for a GitHub project) and Discard, each confirmed. Once landed, where the code went.
 */
export function LandCard({ task }: { task: TaskConversation }) {
  const colors = useColors();
  const { repo, landing, checks, stats } = task.task;
  const isFolder = useStore((s) => s.projects.find((p) => p.id === task.projectId)?.kind === "folder");
  const [options, setOptions] = useState<TaskLandOptions | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"land" | "discard" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Only what mission control calls ready to land: finished, with commits that change something.
  const ready = isReadyToLand(task);

  const load = useCallback(async () => {
    try {
      setOptions(await api.taskLandOptions(task.id));
      setLoadError(null);
    } catch (e) {
      setLoadError(errorMessage(e));
    }
  }, [task.id]);

  // Worked out again whenever the branch, the task's status or its checks change.
  useEffect(() => {
    if (ready && !landing) void load();
  }, [repo?.headSha, task.task.status, ready, landing, checks?.state, load]);

  if (!repo || (!ready && !landing)) return null;

  if (landing) {
    return (
      <View style={[styles.card, styles.landCard, { borderColor: colors.hairline }]}>
        <View style={styles.stateLine}>
          <Icon name={landing.kind === "merged" ? "git-merge" : landing.kind === "pr" ? "git-pull-request" : "trash-2"} size={14} color={colors.fgMuted} />
          <Text style={[typeScale.ui, { color: colors.fg, flex: 1 }]}>{landingLine(landing)}</Text>
        </View>
        <Text style={[typeScale.xs, { color: colors.fgSubtle }]}>
          {landing.kind === "discarded"
            ? "Its worktree is gone, and its branch too unless it had been pushed."
            : landing.kind === "pr"
              ? "Review it and merge it on GitHub when it's ready."
              : "The branch is in your folder now."}
        </Text>
      </View>
    );
  }

  const base = repo.baseBranch || "main";
  // A folder project merges on this click; a GitHub project opens a draft PR. Outside a project, whichever is offered.
  const method: "merge" | "pr" = options ? (options.merge.available ? "merge" : options.pr.available ? "pr" : isFolder ? "merge" : "pr") : isFolder ? "merge" : "pr";
  const option = options ? (method === "merge" ? options.merge : options.pr) : null;
  const landLabel = method === "merge" ? `Merge into ${options?.merge.target ?? base}` : "Open draft PR";

  const land = async () => {
    const ok = await confirm(
      method === "merge" ? `Merge into ${options?.merge.target ?? base}?` : "Open a draft PR?",
      method === "merge" ? `TOT merges ${repo.branch} into your folder's ${options?.merge.target ?? base}.` : `TOT pushes ${repo.branch} and opens a draft pull request against ${options?.pr.base ?? base}.`,
      method === "merge" ? "Merge" : "Open PR",
    );
    if (!ok) return;
    setBusy("land");
    setError(null);
    try {
      await landTask(task.id, { method, headSha: repo.headSha ?? undefined });
    } catch (e) {
      setError(errorMessage(e));
      void load();
    } finally {
      setBusy(null);
    }
  };

  const discard = async () => {
    const ok = await confirm("Discard this task's work?", `This removes its worktree and deletes ${repo.branch}, unless it was pushed. The task and its chat stay.`, "Discard", true);
    if (!ok) return;
    setBusy("discard");
    setError(null);
    try {
      await discardTask(task.id);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={[styles.card, styles.landCard, { borderColor: colors.edge }]}>
      <View style={styles.stateLine}>
        <Icon name="git-branch" size={14} color={colors.fgSubtle} />
        <Text numberOfLines={1} style={[typeScale.ui, { color: colors.fg, flex: 1, fontVariant: ["tabular-nums"] }]}>
          {stats ? statsLine(stats) : "Changes"}
        </Text>
      </View>
      {checks ? (
        <View style={{ gap: 4 }}>
          <View style={styles.stateLine}>
            <ChecksIcon checks={checks} size={14} />
            <Text style={[typeScale.ui, { color: checks.state === "failing" ? colors.danger : colors.fgMuted }]}>
              {checks.state === "none" ? "No checks: this repo has no profile yet" : CHECKS_LABELS[checks.state]}
            </Text>
          </View>
          {checks.lines.map((line, index) => (
            <Text key={index} style={[typeScale.xs, { color: colors.fgSubtle, marginLeft: 22 }]}>
              {line}
            </Text>
          ))}
        </View>
      ) : null}
      {options && (options.behind > 0 || option?.reason) ? (
        <Text style={[typeScale.xs, { color: colors.fgSubtle }]}>
          {[options.behind > 0 ? `${options.behind} commit${options.behind === 1 ? "" : "s"} behind ${base}` : null, option?.reason].filter(Boolean).join(". ")}
        </Text>
      ) : null}
      {loadError ? <Text style={[typeScale.xs, { color: colors.danger }]}>Couldn't check how this task can land. {loadError}</Text> : null}
      {error ? <Text style={[typeScale.xs, { color: colors.danger }]}>{error}</Text> : null}
      <View style={styles.cardActions}>
        <Button label="Discard" variant="secondary" onPress={() => void discard()} busy={busy === "discard"} disabled={busy !== null} style={{ height: 36 }} />
        <Button
          label={landLabel}
          icon={method === "merge" ? "git-merge" : "git-pull-request"}
          onPress={() => void land()}
          busy={busy === "land"}
          disabled={busy !== null || !option?.available}
          style={{ height: 36, flexShrink: 1 }}
        />
      </View>
    </View>
  );
}

const LANDED_ICONS: Record<"merged" | "pr" | "discarded", IconName> = { merged: "git-merge", pr: "git-pull-request", discarded: "x" };

/** Mission control's row: the state at a glance, the title, what it's doing, then its agent, branch, changes and checks. */
export function MissionRow({ task, agentName, now, waiting }: { task: TaskConversation; agentName: string | null; now: number; waiting: boolean }) {
  const colors = useColors();
  const router = useRouter();
  const { status, landing, repo, stats, checks } = task.task;
  const elapsed = taskElapsed(task.task, now);
  const amber = waiting || status === "needs-input";
  const meta = [agentName, repo?.branch, stats?.files ? statsLine(stats) : null].filter(Boolean).join(" · ");
  const actions = taskActions(task);
  return (
    <Pressable
      onPress={() => router.push({ pathname: "/chat/[id]", params: { id: task.id } })}
      onLongPress={actions.length ? () => openTaskMenu(task) : undefined}
      delayLongPress={350}
      style={({ pressed }) => [styles.missionRow, pressed && { backgroundColor: colors.selected }]}
    >
      <View style={{ paddingTop: 1 }}>
        {landing ? (
          <View style={styles.iconBox}>
            <Icon name={LANDED_ICONS[landing.kind]} size={16} color={colors.fgSubtle} />
          </View>
        ) : waiting && status !== "needs-input" ? (
          <TaskStatusIcon status="needs-input" />
        ) : (
          <TaskStatusIcon status={status} />
        )}
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
        <Text numberOfLines={1} style={[typeScale.body, { color: colors.fg }]}>
          {task.title || "Task"}
        </Text>
        <Text numberOfLines={1} style={[typeScale.ui, { color: amber ? colors.warning : status === "failed" ? colors.fgMuted : colors.fgSubtle }]}>
          {waiting && status !== "needs-input" ? "Waiting for your OK" : taskStatusLine(task)}
        </Text>
        {meta || checks ? (
          <View style={styles.meta}>
            {checks ? <ChecksIcon checks={checks} size={12} /> : null}
            <Text numberOfLines={1} style={[typeScale.xs, { color: colors.fgSubtle, flex: 1, fontVariant: ["tabular-nums"] }]}>
              {meta}
            </Text>
          </View>
        ) : null}
      </View>
      {elapsed ? <Text style={[typeScale.xs, { color: colors.fgSubtle, fontVariant: ["tabular-nums"], paddingTop: 3 }]}>{elapsed}</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  iconBox: { width: 20, height: 20, alignItems: "center", justifyContent: "center" },
  card: { borderWidth: StyleSheet.hairlineWidth * 2, borderRadius: 16, padding: 6 },
  landCard: { padding: 14, gap: 8 },
  groupHeader: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 32, paddingHorizontal: 8 },
  groupRow: { flexDirection: "row", alignItems: "center", gap: 10, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 8 },
  notice: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 32, borderRadius: 8, paddingHorizontal: 4 },
  empty: { gap: 20, paddingTop: 8 },
  stateLine: { flexDirection: "row", alignItems: "center", gap: 8 },
  cardActions: { flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 4 },
  missionRow: { flexDirection: "row", alignItems: "flex-start", gap: 12, paddingHorizontal: 16, paddingVertical: 10 },
  meta: { flexDirection: "row", alignItems: "center", gap: 6 },
});
