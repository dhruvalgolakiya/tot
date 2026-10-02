import { useEffect } from "react";
import clsx from "clsx";
import { ArrowLeft, ChevronRight, PanelLeft } from "lucide-react";
import type { Settings } from "@shared/types";
import { DESKTOP_QUERY, useMediaQuery } from "../../hooks/useMediaQuery";
import type { SecretDrafts } from "../../lib/settings";
import {
  backToSettingsList,
  cancelSettingsDiscard,
  confirmSettingsDiscard,
  discardSettingsDraft,
  exitSettings,
  goToSettings,
  loadAppsStatus,
  loadGithubStatus,
  loadSettings,
  refreshProviders,
  saveSettingsDraft,
  selectSettingsDirty,
  selectSettingsValid,
  setSettingsDraft,
  setSettingsSecrets,
  setSidebarOpen,
  useStore,
} from "../../store";
import { ConfirmDialog } from "../ConfirmDialog";
import { MemoryBrowser } from "../MemoryBrowser";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { Tip } from "../ui/Tip";
import { AppsSettings } from "./AppsSettings";
import { ComputerSettings } from "./ComputerSettings";
import { GeneralSettings } from "./GeneralSettings";
import { GitHubSettings } from "./GitHubSettings";
import { ModelsSettings } from "./ModelsSettings";
import { PluginsSettings } from "./PluginsSettings";
import { SETTINGS_SECTIONS, type SettingsSectionMeta } from "./settingsSections";

/** Escape should go back, unless it would steal focus from a menu, dialog, or a field the user is editing. */
function escapeShouldGoBack(): boolean {
  const active = document.activeElement;
  if (active instanceof HTMLElement) {
    if (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT" || active.isContentEditable) {
      return false;
    }
  }
  return !document.querySelector('[role="dialog"], [role="menu"], [data-radix-popper-content-wrapper]');
}

/**
 * Settings as its own page. On desktop the section list lives in the sidebar
 * (see SettingsNav, mounted by Sidebar.tsx); this renders the content column
 * for the active section. On mobile — no sidebar there — this also renders
 * the section list itself as a separate full-screen step.
 */
export function SettingsPage() {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  const rawSection = useStore((s) => s.settingsSection);
  const confirmOpen = useStore((s) => s.settingsConfirmOpen);

  useEffect(() => {
    void refreshProviders({ quiet: true });
    void loadGithubStatus();
    void loadAppsStatus();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented || !escapeShouldGoBack()) return;
      event.preventDefault();
      if (!desktop && rawSection !== null) backToSettingsList();
      else exitSettings();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [desktop, rawSection]);

  return (
    <>
      {!desktop && rawSection === null ? <MobileSectionList /> : <SectionContent section={rawSection ?? "general"} desktop={desktop} />}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={(open) => !open && cancelSettingsDiscard()}
        title="Discard unsaved changes?"
        description="You have unsaved changes. Leaving now will discard them."
        confirmLabel="Discard"
        onConfirm={confirmSettingsDiscard}
      />
    </>
  );
}

/** Mobile only: the section list as its own full screen (desktop shows this in the sidebar instead). */
function MobileSectionList() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-14 shrink-0 items-center gap-1 border-b border-white/[0.06] px-2">
        <IconButton label="Back" onClick={exitSettings}>
          <ArrowLeft />
        </IconButton>
        <span className="text-base font-semibold text-zinc-50">Settings</span>
      </div>
      <nav aria-label="Settings sections" className="min-h-0 flex-1 overflow-y-auto p-2">
        <ul className="space-y-px">
          {SETTINGS_SECTIONS.map(({ id, label, icon: Icon }) => (
            <li key={id}>
              <button
                type="button"
                onClick={() => goToSettings(id)}
                className="flex h-11 w-full items-center gap-3 rounded-lg px-3 text-sm text-zinc-100 transition-colors hover:bg-white/[0.06]"
              >
                <Icon className="size-4 shrink-0 text-zinc-400" />
                <span className="flex-1 text-left">{label}</span>
                <ChevronRight className="size-4 text-zinc-600" />
              </button>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}

/** The active section: title + description, the section's own content, and the sticky save bar when dirty. */
function SectionContent({ section, desktop }: { section: SettingsSectionMeta["id"]; desktop: boolean }) {
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const settings = useStore((s) => s.settings);
  const settingsState = useStore((s) => s.settingsState);
  const draft = useStore((s) => s.settingsDraft);
  const secrets = useStore((s) => s.settingsSecrets);
  const saving = useStore((s) => s.settingsSaving);
  const dirty = useStore(selectSettingsDirty);
  const valid = useStore(selectSettingsValid);
  const meta = SETTINGS_SECTIONS.find((item) => item.id === section)!;

  // Populate the draft once settings arrive, e.g. when settings was still loading on navigation here.
  useEffect(() => {
    if (settings && !draft) setSettingsDraft(settings);
  }, [settings, draft]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      {!desktop ? (
        <div className="flex h-14 shrink-0 items-center gap-1 border-b border-white/[0.06] px-2">
          <IconButton label="Back to settings" onClick={backToSettingsList}>
            <ArrowLeft />
          </IconButton>
          <span className="text-base font-semibold text-zinc-50">{meta.label}</span>
        </div>
      ) : (
        !sidebarOpen && (
          <div className="absolute top-2 left-2 z-10">
            <Tip content="Open sidebar" side="bottom">
              <IconButton label="Open sidebar" onClick={() => setSidebarOpen(true)}>
                <PanelLeft />
              </IconButton>
            </Tip>
          </div>
        )
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[640px] px-6 py-8">
          <div className="mb-6">
            {desktop && <h1 className="text-lg font-semibold text-zinc-50">{meta.label}</h1>}
            <p className={clsx("text-sm text-zinc-500", desktop && "mt-1")}>{meta.description}</p>
          </div>

          {!settings ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center text-sm text-zinc-500">
              {settingsState === "loading" ? (
                "Loading settings…"
              ) : (
                <>
                  Couldn't load settings.
                  <button type="button" onClick={() => void loadSettings()} className="font-medium text-zinc-200 hover:underline">
                    Try again
                  </button>
                </>
              )}
            </div>
          ) : (
            <SectionBody section={section} draft={draft ?? settings} secrets={secrets} />
          )}
        </div>
      </div>

      {meta.hasDraft && dirty && (
        <div className="shrink-0 border-t border-white/[0.06] px-6 py-3">
          <div className="mx-auto flex max-w-[640px] items-center justify-end gap-2">
            <span className="mr-auto text-xs text-zinc-500">Unsaved changes</span>
            <Button variant="ghost" disabled={saving} onClick={discardSettingsDraft}>
              Discard
            </Button>
            <Button variant="primary" disabled={!valid || saving} onClick={() => void saveSettingsDraft()}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function SectionBody({
  section,
  draft,
  secrets,
}: {
  section: SettingsSectionMeta["id"];
  draft: Settings;
  secrets: SecretDrafts;
}) {
  switch (section) {
    case "general":
      return <GeneralSettings draft={draft} onChange={setSettingsDraft} secrets={secrets} onSecretsChange={setSettingsSecrets} />;
    case "models":
      return <ModelsSettings draft={draft} onChange={setSettingsDraft} secrets={secrets} onSecretsChange={setSettingsSecrets} />;
    case "computer":
      return <ComputerSettings draft={draft} onChange={setSettingsDraft} secrets={secrets} onSecretsChange={setSettingsSecrets} />;
    case "memory":
      return <MemoryBrowser />;
    case "github":
      return <GitHubSettings />;
    case "apps":
      return <AppsSettings />;
    case "plugins":
      return <PluginsSettings />;
  }
}
