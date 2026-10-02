import { ArrowLeft, PanelLeftClose } from "lucide-react";
import { exitSettings, goToSettings, setSidebarOpen, useStore } from "../../store";
import { IconButton } from "../ui/IconButton";
import { ListRow } from "../ui/ListRow";
import { Tip } from "../ui/Tip";
import { SETTINGS_SECTIONS } from "./settingsSections";

/**
 * Desktop settings nav: replaces the chats panel next to the agent rail while
 * on the settings page (see Sidebar.tsx). Mirrors the chats panel's header
 * and active-row styling (ConversationList/ConversationItem).
 */
export function SettingsNav() {
  const section = useStore((s) => s.settingsSection) ?? "general";

  return (
    <>
      <div className="group/header flex h-14 shrink-0 items-center gap-1 pr-1.5 pl-1.5">
        <IconButton label="Back" onClick={exitSettings}>
          <ArrowLeft />
        </IconButton>
        <span className="text-sm font-semibold text-fg">Settings</span>
        <Tip content="Close sidebar" side="bottom">
          <IconButton
            label="Close sidebar"
            size="sm"
            className="ml-auto opacity-0 transition-opacity group-hover/header:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
            onClick={() => setSidebarOpen(false)}
          >
            <PanelLeftClose />
          </IconButton>
        </Tip>
      </div>

      <nav aria-label="Settings sections" className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <ul className="space-y-px">
          {SETTINGS_SECTIONS.map(({ id, label, icon: Icon }) => {
            const active = id === section;
            return (
              <li key={id}>
                <ListRow icon={<Icon />} selected={active} aria-current={active ? "page" : undefined} onClick={() => goToSettings(id)}>
                  {label}
                </ListRow>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
