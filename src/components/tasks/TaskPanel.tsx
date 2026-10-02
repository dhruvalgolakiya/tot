import type { ReactNode } from "react";
import { Tabs } from "radix-ui";
import { ListChecks } from "lucide-react";
import { isTask, type TaskConversation } from "../../lib/tasks";
import { selectCurrentConversation, setTaskPanelOpen, setTaskPanelTab, useStore, type TaskPanelTab } from "../../store";
import { SidePanel } from "../ui/SidePanel";
import { ActivityTab } from "./ActivityTab";
import { ChangesTab } from "./ChangesTab";
import { PlanTab } from "./PlanTab";

const tabTrigger =
  "relative -mb-px flex h-10 items-center border-b-2 border-transparent px-3 text-sm text-fg-muted outline-none transition-colors " +
  "hover:text-fg focus-visible:text-fg data-[state=active]:border-fg data-[state=active]:text-fg";

/**
 * The panel's tabs. Each stands alone, so later modules add theirs (checks, the pull request)
 * here without touching the others; `shown` hides a tab for tasks it doesn't apply to.
 */
const TABS: { id: TaskPanelTab; label: string; shown?: (task: TaskConversation) => boolean; render: (task: TaskConversation) => ReactNode }[] = [
  { id: "plan", label: "Plan", render: (task) => <PlanTab task={task} /> },
  { id: "changes", label: "Changes", shown: (task) => Boolean(task.task.repo), render: (task) => <ChangesTab task={task} /> },
  { id: "activity", label: "Activity", render: (task) => <ActivityTab task={task} /> },
];

/** Right-hand panel for the open task: its plan, its branch's changes, and what it ran. */
export function TaskPanel() {
  const open = useStore((s) => s.taskPanelOpen);
  const tab = useStore((s) => s.taskPanelTab);
  const conversation = useStore(selectCurrentConversation);
  if (!open || !isTask(conversation)) return null;
  const tabs = TABS.filter((t) => !t.shown || t.shown(conversation));
  const active = tabs.some((t) => t.id === tab) ? tab : "plan";

  return (
    <SidePanel label="Task" icon={<ListChecks />} title="Task" onClose={() => setTaskPanelOpen(false)} width="w-[440px]">
      <Tabs.Root value={active} onValueChange={(value) => setTaskPanelTab(value as TaskPanelTab)} className="flex min-h-0 flex-1 flex-col">
        <Tabs.List aria-label="Task sections" className="flex shrink-0 gap-1 border-b border-hairline px-4">
          {tabs.map((t) => (
            <Tabs.Trigger key={t.id} value={t.id} className={tabTrigger}>
              {t.label}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
        {tabs.map((t) => (
          <Tabs.Content key={t.id} value={t.id} className="min-h-0 flex-1 overflow-y-auto p-4 outline-none">
            {t.render(conversation)}
          </Tabs.Content>
        ))}
      </Tabs.Root>
    </SidePanel>
  );
}
