import { Tabs } from "radix-ui";
import { Settings } from "lucide-react";
import {
  closeAgentSettings,
  navigateToConversation,
  selectActiveAgent,
  setAgentSettingsTab,
  useStore,
  type AgentSettingsTab,
} from "../store";
import { AgentForm } from "./AgentForm";
import { RoutinesPanel } from "./routines/RoutinesPanel";
import { SidePanel } from "./ui/SidePanel";

const tabTrigger =
  "relative -mb-px border-b-2 border-transparent px-3 py-2.5 text-sm text-zinc-400 transition-colors outline-none " +
  "hover:text-zinc-200 focus-visible:text-zinc-100 data-[state=active]:border-[var(--agent-accent)] data-[state=active]:text-zinc-50";

/** Right-hand panel with the active agent's profile and routines; follows the agent picked in the rail. */
export function AgentSettingsPanel() {
  const open = useStore((s) => s.agentSettingsOpen);
  const tab = useStore((s) => s.agentSettingsTab);
  const agent = useStore(selectActiveAgent);
  const canDelete = useStore((s) => s.agents.length > 1);

  if (!open || !agent) return null;

  return (
    <SidePanel label="Agent settings" icon={<Settings />} title={`${agent.name} settings`} onClose={closeAgentSettings} width="w-[400px]">
      <Tabs.Root
        key={agent.id}
        value={tab}
        onValueChange={(value) => setAgentSettingsTab(value as AgentSettingsTab)}
        className="flex min-h-0 flex-1 flex-col"
      >
        <Tabs.List aria-label="Agent sections" className="flex shrink-0 gap-1 border-b border-white/[0.06] px-4">
          <Tabs.Trigger value="profile" className={tabTrigger}>
            Profile
          </Tabs.Trigger>
          <Tabs.Trigger value="routines" className={tabTrigger}>
            Routines
          </Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="profile" className="flex min-h-0 flex-1 flex-col outline-none">
          <AgentForm target={agent} canDelete={canDelete} />
        </Tabs.Content>
        <Tabs.Content value="routines" className="min-h-0 flex-1 overflow-y-auto px-5 py-4 outline-none">
          <RoutinesPanel
            agentId={agent.id}
            agentName={agent.name}
            onOpenConversation={(id) => {
              closeAgentSettings();
              navigateToConversation(id);
            }}
          />
        </Tabs.Content>
      </Tabs.Root>
    </SidePanel>
  );
}
