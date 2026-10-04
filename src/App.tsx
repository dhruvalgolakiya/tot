import { useEffect, type CSSProperties } from "react";
import { Toaster } from "sonner";
import { useResolvedTheme } from "./lib/theme";
import { Tooltip } from "radix-ui";
import { AgentSettingsPanel } from "./components/AgentSettingsPanel";
import { ChatView } from "./components/ChatView";
import { ComputerPanel } from "./components/ComputerPanel";
import { Header } from "./components/Header";
import { MascotGallery } from "./components/mascot";
import { NewAgentDialog } from "./components/NewAgentDialog";
import { NewProjectDialog } from "./components/projects/NewProjectDialog";
import { ProjectPage } from "./components/projects/ProjectPage";
import { SettingsPage } from "./components/settings/SettingsPage";
import { TrustLab } from "./components/trust/TrustLab";
import { Sidebar } from "./components/Sidebar";
import { TaskPanel } from "./components/tasks/TaskPanel";
import { WikiView } from "./components/wiki/WikiView";
import { useAgentAccent } from "./hooks/useAgentAccent";
import { useAppEvents, useRunningAgents } from "./hooks/useAppEvents";
import { useGlobalShortcuts } from "./hooks/useGlobalShortcuts";
import { conversationTitle } from "./lib/conversations";
import { loadMarkdown } from "./lib/markdownLoader";
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
  const current = useStore(selectCurrentConversation);
  const pageProjectId = useStore((s) => (s.page === "project" ? s.projectId : null));
  const projectName = useProjects((s) => (pageProjectId ? s.projects.find((p) => p.id === pageProjectId)?.name : undefined));
  const title = current ? conversationTitle(current) : (projectName ?? null);

  useEffect(() => {
    initApp();
    void loadMarkdown(); // Warm the renderer chunk before the first reply arrives.
    syncWithLocation();
    window.addEventListener("popstate", syncWithLocation);
    // Testing/screenshot affordance: ?dialog=new-agent|settings or ?panel=computer opens
    // that surface on load, since it otherwise only opens from a click.
    const params = new URLSearchParams(window.location.search);
    if (params.get("dialog") === "new-agent") setNewAgentDialogOpen(true);
    if (params.get("dialog") === "settings") goToSettings();
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

  useEffect(() => {
    document.title = title ? `${title} · TOT` : page === "settings" ? "Settings · TOT" : "TOT";
  }, [title, page]);

  useGlobalShortcuts();
  useAgentAccent();

  // Live app-wide updates: background routine runs, agents/chats created or
  // removed elsewhere, computers starting and stopping. No-replay stream, so
  // a reconnect refetches the lists it might have missed.
  useAppEvents(handleAppEvent, handleAppReconnect);
  const runningAgents = useRunningAgents();
  useEffect(() => setRunningAgents(runningAgents), [runningAgents]);

  if (page === "mascots") return <MascotGallery />;

  return (
    <Tooltip.Provider delayDuration={350} skipDelayDuration={150}>
      <div className="flex h-dvh overflow-hidden bg-canvas text-fg md:bg-panel">
        <Sidebar />
        {/* Full-bleed chat canvas, flush against the sidebar (no inset card, no divider — ChatGPT-style). */}
        <main className="relative flex min-w-0 flex-1 flex-col overflow-hidden bg-canvas">
          {page === "settings" ? (
            <SettingsPage key={viewKey} />
          ) : page === "trust-lab" ? (
            <TrustLab key={viewKey} />
          ) : (
            <>
              <Header />
              {page === "wiki" ? (
                <WikiView key={viewKey} />
              ) : page === "project" ? (
                <ProjectPage key={viewKey} />
              ) : (
                <ChatView key={viewKey} />
              )}
            </>
          )}
        </main>
        <ComputerPanel />
        <TaskPanel />
        <AgentSettingsPanel />
      </div>
      <NewAgentDialog />
      <NewProjectDialog />
      <Toaster theme={theme} position="top-center" closeButton style={TOAST_THEME} />
    </Tooltip.Provider>
  );
}
