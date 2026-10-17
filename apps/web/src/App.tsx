import { Suspense, useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { Toaster } from "sonner";
import { LoaderCircle } from "lucide-react";
import { useResolvedTheme } from "./lib/theme";
import { Tooltip } from "radix-ui";
import { ChatView } from "./components/ChatView";
import { Header } from "./components/Header";
import { Sidebar } from "./components/Sidebar";
import { useAgentAccent } from "./hooks/useAgentAccent";
import { useAppEvents, useRunningAgents } from "./hooks/useAppEvents";
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts";
import { conversationTitle } from "./lib/conversations";
import { whenIdle } from "./lib/idle";
import { lazyComponent } from "./lib/lazyComponent";
import { setPaletteOpen, usePalette } from "./lib/palette";
import { useProjects } from "./lib/projects";
import {
  goToSettings,
  handleAppEvent,
  handleAppReconnect,
  initApp,
  refreshProviders,
  selectActiveAgent,
  selectCurrentConversation,
  setComputerPanelOpen,
  setNewAgentDialogOpen,
  setRunningAgents,
  syncWithLocation,
  useStore,
} from "./store";

// Everything but the chat loads on demand, in chunks of its own, so the app starts on a smaller bundle; once
// the first screen has settled they're fetched ahead of time (PRELOAD, below), so opening one doesn't wait.
const SettingsPage = lazyComponent(() => import("./components/settings/SettingsPage"), "SettingsPage");
const TrustLab = lazyComponent(() => import("./components/trust/TrustLab"), "TrustLab");
const WikiView = lazyComponent(() => import("./components/wiki/WikiView"), "WikiView");
const ProjectPage = lazyComponent(() => import("./components/projects/ProjectPage"), "ProjectPage");
const MissionControl = lazyComponent(() => import("./components/mission/MissionControl"), "MissionControl");
const CompareView = lazyComponent(() => import("./components/mission/CompareView"), "CompareView");
const CrewPage = lazyComponent(() => import("./components/crew/CrewPage"), "CrewPage");
const MascotGallery = lazyComponent(() => import("./components/mascot/MascotGallery"), "MascotGallery");
const ComputerPanel = lazyComponent(() => import("./components/ComputerPanel"), "ComputerPanel");
const TaskPanel = lazyComponent(() => import("./components/tasks/TaskPanel"), "TaskPanel");
const AgentSettingsPanel = lazyComponent(() => import("./components/AgentSettingsPanel"), "AgentSettingsPanel");
const NewAgentDialog = lazyComponent(() => import("./components/NewAgentDialog"), "NewAgentDialog");
const NewProjectDialog = lazyComponent(() => import("./components/projects/NewProjectDialog"), "NewProjectDialog");
const CommandPalette = lazyComponent(() => import("./components/palette/CommandPalette"), "CommandPalette");

/** Fetched one at a time while the browser is idle, the likeliest first. */
const PRELOAD = [
  CommandPalette,
  ProjectPage,
  WikiView,
  SettingsPage,
  NewProjectDialog,
  ComputerPanel,
  TaskPanel,
  AgentSettingsPanel,
  MissionControl,
  NewAgentDialog,
  CrewPage,
  CompareView,
  TrustLab,
];
/** How long after starting to wait before preloading: the open chat and the markdown renderer come first. */
const PRELOAD_AFTER_MS = 1500;

/**
 * A lazily loaded page's place while its chunk arrives. Usually it was preloaded and this never shows; on a slow
 * connection a spinner fades in after a moment, rather than flashing for a few milliseconds.
 */
function PageFallback() {
  return (
    <div className="grid flex-1 place-items-center" aria-busy="true">
      <LoaderCircle className="size-5 animate-[fade-in_200ms_ease-out_600ms_both] animate-spin text-fg-subtle" />
    </div>
  );
}

function Page({ children }: { children: ReactNode }) {
  return <Suspense fallback={<PageFallback />}>{children}</Suspense>;
}

/** Mounts a lazily loaded panel or dialog once it first opens, and keeps it (a dialog animates closed). */
function OnceOpened({ useOpen, children }: { useOpen: () => boolean; children: ReactNode }) {
  const open = useOpen();
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  return opened ? <Suspense fallback={null}>{children}</Suspense> : null;
}

const useComputerPanelOpen = () => useStore((s) => s.computerPanelOpen);
const useTaskPanelOpen = () => useStore((s) => s.taskPanelOpen);
const useAgentSettingsOpen = () => useStore((s) => s.agentSettingsOpen);
const useNewAgentDialogOpen = () => useStore((s) => s.newAgentDialogOpen);
const useNewProjectOpen = () => useProjects((s) => s.newProjectOpen);
const usePaletteOpen = () => usePalette((s) => s.open);

/** The browser tab's title: the open chat (or project page), else the page. */
function DocumentTitle() {
  const page = useStore((s) => s.page);
  const chatTitle = useStore((s) => {
    const current = selectCurrentConversation(s);
    return current ? conversationTitle(current) : null;
  });
  const pageProjectId = useStore((s) => (s.page === "project" ? s.projectId : null));
  const projectName = useProjects((s) => (pageProjectId ? s.projects.find((p) => p.id === pageProjectId)?.name : undefined));
  // A project's page shows its Lead (module 11), but it's the project's page: the project names the tab.
  const title = projectName ?? chatTitle;

  useEffect(() => {
    document.title = title
      ? `${title} · TOT`
      : page === "settings"
        ? "Settings · TOT"
        : page === "wiki"
          ? "Knowledge · TOT"
          : page === "mission"
            ? "Mission control · TOT"
            : page === "compare"
              ? "Compare · TOT"
              : page === "crew"
                ? "Your crew · TOT"
                : "TOT";
  }, [title, page]);
  return null;
}

const PROVIDER_RECHECK_MS = 15_000;

// Sonner reads its colors from these variables; they follow the theme palette.
const TOAST_THEME = {
  "--normal-bg": "var(--color-elevated)",
  "--normal-border": "var(--color-edge)",
  "--normal-text": "var(--color-fg)",
} as CSSProperties;

export default function App() {
  const theme = useResolvedTheme();
  const page = useStore((s) => s.page);
  const viewKey = useStore((s) => s.viewKey);

  useEffect(() => {
    initApp();
    syncWithLocation();
    window.addEventListener("popstate", syncWithLocation);
    // Testing/screenshot affordance: ?dialog=new-agent|settings|palette or ?panel=computer opens
    // that surface on load, since it otherwise only opens from a click.
    const params = new URLSearchParams(window.location.search);
    if (params.get("dialog") === "new-agent") setNewAgentDialogOpen(true);
    if (params.get("dialog") === "settings") goToSettings();
    if (params.get("dialog") === "palette") setPaletteOpen(true);
    let unsubscribe: (() => void) | undefined;
    if (params.get("panel") === "computer") {
      // The initial agents fetch resolves after this effect and re-syncs the
      // home route, which closes the panel again (it's scoped to an agent).
      // Wait for that to settle before opening it.
      const openWhenReady = (): boolean => {
        const s = useStore.getState();
        if (s.page === "home" && s.homeAgentId === null) return false;
        if (!selectActiveAgent(s)) return false;
        // Unsubscribe before flipping the flag: zustand notifies listeners on
        // every set() regardless of whether the value actually changed, so
        // this would otherwise re-enter itself and recurse forever.
        unsubscribe?.();
        setComputerPanelOpen(true);
        return true;
      };
      if (!openWhenReady()) unsubscribe = useStore.subscribe(openWhenReady);
    }
    return () => {
      window.removeEventListener("popstate", syncWithLocation);
      unsubscribe?.();
    };
  }, []);

  // The other pages' chunks, once the first screen has settled: one at a time, each when the browser is idle.
  useEffect(() => {
    let cancel = () => {};
    let index = 0;
    const next = () => {
      const component = PRELOAD[index++];
      if (!component) return;
      void component.preload().then(
        () => (cancel = whenIdle(next, 2000)),
        () => {},
      );
    };
    const timer = window.setTimeout(() => (cancel = whenIdle(next, 2000)), PRELOAD_AFTER_MS);
    return () => {
      window.clearTimeout(timer);
      cancel();
    };
  }, []);

  // Pick up logins done in a terminal/browser while TOT was in the background.
  useEffect(() => {
    let lastCheck = Date.now();
    const onFocus = () => {
      if (Date.now() - lastCheck < PROVIDER_RECHECK_MS) return;
      lastCheck = Date.now();
      void refreshProviders({ quiet: true });
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  useGlobalShortcuts();
  useAgentAccent();

  // Live app-wide updates: background routine runs, agents/chats created or
  // removed elsewhere, computers starting and stopping. No-replay stream, so
  // a reconnect refetches the lists it might have missed.
  useAppEvents(handleAppEvent, handleAppReconnect);
  const runningAgents = useRunningAgents();
  useEffect(() => setRunningAgents(runningAgents), [runningAgents]);

  if (page === "mascots") {
    return (
      <Suspense fallback={null}>
        <MascotGallery />
      </Suspense>
    );
  }

  return (
    <Tooltip.Provider delayDuration={350} skipDelayDuration={150}>
      <DocumentTitle />
      <div className="flex h-dvh overflow-hidden bg-canvas text-fg md:bg-panel">
        <Sidebar />
        {/* Full-bleed chat canvas, flush against the sidebar (no inset card, no divider — ChatGPT-style). */}
        <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-canvas">
          {page === "settings" ? (
            <Page>
              <SettingsPage key={viewKey} />
            </Page>
          ) : page === "trust-lab" ? (
            <Page>
              <TrustLab key={viewKey} />
            </Page>
          ) : (
            <>
              <Header />
              {page === "wiki" ? (
                <Page>
                  <WikiView key={viewKey} />
                </Page>
              ) : page === "project" ? (
                <Page>
                  <ProjectPage key={viewKey} />
                </Page>
              ) : page === "mission" ? (
                <Page>
                  <MissionControl key={viewKey} />
                </Page>
              ) : page === "compare" ? (
                <Page>
                  <CompareView key={viewKey} />
                </Page>
              ) : page === "crew" ? (
                <Page>
                  <CrewPage key={viewKey} />
                </Page>
              ) : (
                // Not keyed by the route: it keeps recent chats mounted across switches (see ChatView).
                <ChatView />
              )}
            </>
          )}
        </main>
        <OnceOpened useOpen={useComputerPanelOpen}>
          <ComputerPanel />
        </OnceOpened>
        <OnceOpened useOpen={useTaskPanelOpen}>
          <TaskPanel />
        </OnceOpened>
        <OnceOpened useOpen={useAgentSettingsOpen}>
          <AgentSettingsPanel />
        </OnceOpened>
      </div>
      <OnceOpened useOpen={useNewAgentDialogOpen}>
        <NewAgentDialog />
      </OnceOpened>
      <OnceOpened useOpen={useNewProjectOpen}>
        <NewProjectDialog />
      </OnceOpened>
      <OnceOpened useOpen={usePaletteOpen}>
        <CommandPalette />
      </OnceOpened>
      <Toaster theme={theme} position="top-center" closeButton style={TOAST_THEME} />
    </Tooltip.Provider>
  );
}
