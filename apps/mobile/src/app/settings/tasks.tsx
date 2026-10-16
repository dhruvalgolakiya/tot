import { useEffect, useState } from "react";
import { Alert } from "react-native";
import type { TaskSettings } from "@shared/types";
import { Cell, FieldCell, Group, LoadState, SettingsScroll, Stepper, SwitchCell } from "../../components/settings";
import { api, errorMessage } from "../../lib/api";
import { loadAll, saveSettings, useStore } from "../../lib/store";

/** The web's limits (src/lib/settings.ts): the server refuses anything outside them. */
const LIMITS = { perAgent: 10, global: 20, children: 20 };
const CLEANUP_MAX = 365;

/**
 * Settings → Tasks, as the web's: how many run at once, splitting work, restarts and notifications, and old
 * worktrees. Each change saves at once.
 */
export default function TasksSettings() {
  const settings = useStore((s) => s.settings);
  const tasks = settings?.tasks;
  const [days, setDays] = useState(String(tasks?.worktreeCleanupDays ?? ""));
  const [cleaning, setCleaning] = useState(false);
  useEffect(() => setDays(String(tasks?.worktreeCleanupDays ?? "")), [tasks?.worktreeCleanupDays]);

  if (!settings || !tasks) return <SettingsScroll><LoadState error="Couldn't load settings." onRetry={() => void loadAll()} /></SettingsScroll>;

  const update = (patch: Partial<TaskSettings>) => void saveSettings({ tasks: patch });

  const saveDays = () => {
    const value = Number(days);
    if (days.trim() === "" || !Number.isInteger(value) || value < 0 || value > CLEANUP_MAX) {
      setDays(String(tasks.worktreeCleanupDays));
      Alert.alert("Use a whole number of days", `0–${CLEANUP_MAX}. 0 keeps them.`);
      return;
    }
    if (value !== tasks.worktreeCleanupDays) update({ worktreeCleanupDays: value });
  };

  const cleanUp = async () => {
    setCleaning(true);
    try {
      const { removed } = await api.cleanUpWorktrees(tasks.worktreeCleanupDays);
      Alert.alert(removed ? `Removed ${removed} worktree${removed === 1 ? "" : "s"}` : "Nothing to clean up");
    } catch (error) {
      Alert.alert("Couldn't clean up", errorMessage(error));
    } finally {
      setCleaning(false);
    }
  };

  const slackPerson = tasks.notifySlackUserId ? "On" : "Off";
  const cleanupOn = tasks.worktreeCleanupDays >= 1;

  return (
    <SettingsScroll>
      <Group title="Running at once" footer="Each agent has one computer, so it works on a few tasks at a time; the rest wait in its queue. The total is a cap for everything running at once, so your model plans aren't stretched too thin.">
        <Cell title="Tasks per agent" right={<Stepper label="tasks per agent" value={tasks.perAgentLimit} min={1} max={LIMITS.perAgent} onChange={(perAgentLimit) => update({ perAgentLimit })} />} />
        <Cell title="Tasks across all agents" right={<Stepper label="tasks across all agents" value={tasks.globalLimit} min={1} max={LIMITS.global} onChange={(globalLimit) => update({ globalLimit })} />} />
      </Group>

      <Group title="Splitting work">
        <SwitchCell
          title="Switch providers when one hits its limit"
          subtitle="A task that runs into Claude's or ChatGPT's usage limit writes a handoff and carries on with the other. Off: it pauses until the limit resets."
          value={tasks.switchProviders}
          onValueChange={(switchProviders) => update({ switchProviders })}
        />
        <Cell
          title="Tasks one chat or task can start"
          subtitle="Caps how far TOT fans out a single request."
          right={<Stepper label="tasks one chat can start" value={tasks.maxChildren} min={1} max={LIMITS.children} onChange={(maxChildren) => update({ maxChildren })} />}
        />
      </Group>

      <Group title="Restarts and notifications">
        <SwitchCell
          title="Resume interrupted tasks"
          subtitle="When TOT restarts in the middle of a task, pick it back up by itself."
          value={tasks.resumeInterrupted}
          onValueChange={(resumeInterrupted) => update({ resumeInterrupted })}
        />
        <SwitchCell
          title="Tell the chat when its tasks finish"
          subtitle="The chat picks up the results and replies by itself, instead of waiting for your next message."
          value={tasks.wakeChats}
          onValueChange={(wakeChats) => update({ wakeChats })}
        />
        <Cell title="Also tell me on Slack" subtitle="Who gets the Slack message is picked on the computer (Settings → Tasks)." value={slackPerson} />
      </Group>

      <Group
        title="Worktrees"
        footer="A task that finished but was never merged, opened as a pull request or discarded keeps its worktree this long. Its branch always stays. 0 keeps them."
      >
        <FieldCell
          title="Remove finished worktrees after (days)"
          value={days}
          onChangeText={setDays}
          onEndEditing={saveDays}
          keyboardType="number-pad"
          returnKeyType="done"
          maxLength={3}
        />
        <Cell
          title={cleaning ? "Cleaning up…" : "Clean up now"}
          subtitle={cleanupOn ? `Removes worktrees older than ${tasks.worktreeCleanupDays} day${tasks.worktreeCleanupDays === 1 ? "" : "s"} now, instead of at the daily sweep.` : "Cleanup is off. Set a number of days to remove old worktrees."}
          disabled={cleaning || !cleanupOn}
          onPress={() => void cleanUp()}
        />
      </Group>
    </SettingsScroll>
  );
}
