import { useEffect } from "react";
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
  loadPersonas,
  loadSettings,
  loadSlackStatus,
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
import { Callout } from "../ui/Callout";
import { IconButton } from "../ui/IconButton";
import { ListRow } from "../ui/ListRow";
import { PageHeader } from "../ui/SectionHeader";
import { Skeleton } from "../ui/Skeleton";
import { Tip } from "../ui/Tip";
import { WorkflowsSettings } from "../trust/WorkflowsSettings";
import { AppsSettings } from "./AppsSettings";
import { ComputerSettings } from "./ComputerSettings";
import { DevicesSettings } from "./DevicesSettings";
import { GeneralSettings } from "./GeneralSettings";
import { GitHubSettings } from "./GitHubSettings";
import { ModelsSettings } from "./ModelsSettings";
import { PersonasSettings } from "./PersonasSettings";
import { PluginsSettings } from "./PluginsSettings";
import { SETTINGS_SECTIONS, type SettingsSectionMeta } from "./settingsSections";
import { SlackSettings } from "./SlackSettings";
import { TasksSettings } from "../tasks/TasksSettings";

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
    void loadSlackStatus();
    void loadPersonas();
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
      <div className="flex h-14 shrink-0 items-center gap-1 border-b border-hairline px-2">
        <IconButton label="Back" onClick={exitSettings}>
          <ArrowLeft />
        </IconButton>
        <span className="text-heading text-fg-strong">Settings</span>
      </div>
      <nav aria-label="Settings sections" className="min-h-0 flex-1 overflow-y-auto p-2">
        <ul className="space-y-px">
          {SETTINGS_SECTIONS.map(({ id, label, icon: Icon }) => (
            <li key={id}>
              <ListRow icon={<Icon />} trailing={<ChevronRight />} onClick={() => goToSettings(id)}>
                {label}
              </ListRow>
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
        <div className="flex h-14 shrink-0 items-center gap-1 border-b border-hairline px-2">
          <IconButton label="Back to settings" onClick={backToSettingsList}>
            <ArrowLeft />
          </IconButton>
          <span className="text-heading text-fg-strong">{meta.label}</span>
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
          <PageHeader title={desktop ? meta.label : undefined} description={meta.description} className="mb-8" />

          {!settings ? (
            settingsState === "loading" ? (
              <div className="space-y-6" aria-busy="true" aria-label="Loading settings">
                <Skeleton className="h-9 w-2/3 rounded-lg" />
                <Skeleton className="h-24 w-full rounded-xl" />
                <Skeleton className="h-9 w-full rounded-lg" />
              </div>
            ) : (
              <Callout
                tone="danger"
                action={
                  <button type="button" onClick={() => void loadSettings()} className="link-muted">
                    Try again
                  </button>
                }
              >
                Couldn't load settings.
              </Callout>
            )
          ) : (
            <SectionBody section={section} draft={draft ?? settings} secrets={secrets} />
          )}
        </div>
      </div>

      {meta.hasDraft && dirty && (
        <div className="shrink-0 border-t border-hairline px-6 py-3">
          <div className="mx-auto flex max-w-[640px] items-center justify-end gap-2">
            <span className="mr-auto text-xs text-fg-subtle">Unsaved changes</span>
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
    case "devices":
      return <DevicesSettings />;
    case "models":
      return <ModelsSettings draft={draft} onChange={setSettingsDraft} secrets={secrets} onSecretsChange={setSettingsSecrets} />;
    case "computer":
      return <ComputerSettings draft={draft} onChange={setSettingsDraft} secrets={secrets} onSecretsChange={setSettingsSecrets} />;
    case "tasks":
      return <TasksSettings draft={draft} onChange={setSettingsDraft} secrets={secrets} onSecretsChange={setSettingsSecrets} />;
    case "memory":
      return <MemoryBrowser />;
    case "github":
      return <GitHubSettings />;
    case "workflows":
      return <WorkflowsSettings />;
    case "apps":
      return <AppsSettings />;
    case "slack":
      return <SlackSettings />;
    case "personas":
      return <PersonasSettings />;
    case "plugins":
      return <PluginsSettings />;
  }
}
