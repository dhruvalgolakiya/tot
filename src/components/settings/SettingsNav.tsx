import clsx from "clsx";
import { ArrowLeft, PanelLeftClose } from "lucide-react";
import { exitSettings, goToSettings, setSidebarOpen, useStore } from "../../store";
import { IconButton } from "../ui/IconButton";
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
        <span className="text-sm font-semibold text-zinc-100">Settings</span>
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
                <button
                  type="button"
                  onClick={() => goToSettings(id)}
                  aria-current={active ? "page" : undefined}
                  className={clsx(
                    "flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13px] transition-colors",
                    active ? "bg-white/[0.08] text-zinc-50" : "text-white/70 hover:bg-white/[0.04] hover:text-zinc-100",
                  )}
                >
                  <Icon className="size-4 shrink-0" />
                  {label}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
