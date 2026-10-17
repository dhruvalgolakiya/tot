import { Suspense, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import clsx from "clsx";
import { Tabs } from "radix-ui";
import { X } from "lucide-react";
import type { Conversation } from "@tot/shared/types";
import type { WorkspaceInfo, WorkspaceTab } from "@tot/shared/workspace";
import { useMediaQuery, WIDE_QUERY } from "../../hooks/useMediaQuery";
import { errorMessage } from "../../lib/api";
import { lazyComponent } from "../../lib/lazyComponent";
import {
  hasWorkspace,
  PANEL_MIN_WIDTH,
  setWorkspacePanelOpen,
  setWorkspacePanelWidth,
  setWorkspaceTab,
  useWorkspacePanel,
  workspaceApi,
} from "../../lib/workspace";
import { selectCurrentConversation, useStore } from "../../store";
import { EmptyState } from "../ui/EmptyState";
import { IconButton } from "../ui/IconButton";
import { Skeleton } from "../ui/Skeleton";
import { Tip } from "../ui/Tip";

const DiffTab = lazyComponent(() => import("./DiffTab"), "DiffTab");

const TABS: { id: WorkspaceTab; label: string }[] = [
  { id: "diff", label: "Diff" },
  { id: "files", label: "Files" },
  { id: "terminal", label: "Terminal" },
  { id: "browser", label: "Browser" },
];

const tabTrigger =
  "relative -mb-px flex h-14 items-center border-b-2 border-transparent px-2.5 text-sm text-fg-muted outline-none transition-colors " +
  "hover:text-fg focus-visible:text-fg data-[state=active]:border-fg data-[state=active]:text-fg";

/** The chat column keeps at least this much room beside a docked panel. */
const CHAT_ROOM = "28rem";

type InfoState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; info: WorkspaceInfo };

/** What the panel knows about the chat's folder, asked again when the chat's workspace changes (its worktree made). */
function useWorkspaceInfo(chat: Conversation): InfoState {
  const [state, setState] = useState<{ chatId: string; value: InfoState } | null>(null);
  const workspace = JSON.stringify(chat.workspace);
  useEffect(() => {
    let live = true;
    workspaceApi.info(chat.id).then(
      (info) => live && setState({ chatId: chat.id, value: { status: "ready", info } }),
      (error) => live && setState({ chatId: chat.id, value: { status: "error", message: errorMessage(error) } }),
    );
    return () => {
      live = false;
    };
  }, [chat.id, workspace]);
  return state?.chatId === chat.id ? state.value : { status: "loading" };
}

/** Dragging the panel's left edge: wider to the left, narrower to the right; the width is kept once it's let go. */
function ResizeHandle() {
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const startWidth = useWorkspacePanel.getState().width;
    const panel = handle.parentElement;
    const max = () => (panel?.parentElement ? panel.parentElement.clientWidth * 0.75 : window.innerWidth);
    const onMove = (move: PointerEvent) => setWorkspacePanelWidth(Math.min(max(), startWidth + startX - move.clientX));
    const onUp = () => {
      handle.removeEventListener("pointermove", onMove);
      handle.removeEventListener("pointerup", onUp);
      handle.removeEventListener("pointercancel", onUp);
      document.body.style.removeProperty("cursor");
      setWorkspacePanelWidth(useWorkspacePanel.getState().width, { save: true });
    };
    document.body.style.cursor = "col-resize";
    handle.addEventListener("pointermove", onMove);
    handle.addEventListener("pointerup", onUp);
    handle.addEventListener("pointercancel", onUp);
  };
  const onKeyDown = (event: ReactKeyboardEvent) => {
    const step = event.shiftKey ? 64 : 16;
    const width = useWorkspacePanel.getState().width;
    if (event.key === "ArrowLeft") setWorkspacePanelWidth(width + step, { save: true });
    else if (event.key === "ArrowRight") setWorkspacePanelWidth(width - step, { save: true });
    else return;
    event.preventDefault();
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize workspace panel"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      className="group absolute inset-y-0 left-0 z-10 w-2 -translate-x-1/2 cursor-col-resize touch-none focus-visible:outline-none"
    >
      <div className="mx-auto h-full w-px bg-transparent transition-colors group-hover:bg-edge-strong group-focus-visible:bg-edge-strong group-active:bg-edge-strong" />
    </div>
  );
}

function TabFallback() {
  return (
    <div className="space-y-2 p-4" aria-busy="true">
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  );
}

/** One tab's content. Each tab is its own module, loaded the first time it's shown. */
function TabBody({ tab, chat, info }: { tab: WorkspaceTab; chat: Conversation; info: WorkspaceInfo }): ReactNode {
  const body =
    tab === "diff" ? (
      <DiffTab key={chat.id} chat={chat} info={info} />
    ) : (
      <EmptyState size="sm" title={TABS.find((t) => t.id === tab)!.label} description="Nothing here yet." />
    );
  return <Suspense fallback={<TabFallback />}>{body}</Suspense>;
}

/**
 * Right-hand panel for the open chat's folder (its project's checkout, or its own worktree): its changes, its
 * files, terminals in it and the dev servers it runs. Docked beside the chat on wide screens, resizable from its
 * left edge; a sliding overlay otherwise. Escape closes it while focus is inside it (a terminal or an editor
 * keeps its own Escape).
 */
export function WorkspacePanel() {
  const open = useWorkspacePanel((s) => s.open);
  const chat = useStore(selectCurrentConversation);
  const chatPage = useStore((s) => s.page === "home" || s.page === "chat");
  if (!open || !chatPage || !hasWorkspace(chat)) return null;
  return <Panel chat={chat} />;
}

function Panel({ chat }: { chat: Conversation }) {
  const wide = useMediaQuery(WIDE_QUERY);
  const width = useWorkspacePanel((s) => s.width);
  const tab = useWorkspacePanel((s) => s.tabs[chat.id] ?? "diff");
  const info = useWorkspaceInfo(chat);
  const panelRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const focused = document.activeElement;
      if (!panelRef.current?.contains(focused) || focused?.closest("[data-own-escape]")) return;
      setWorkspacePanelOpen(false);
      document.getElementById("composer-input")?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const close = () => setWorkspacePanelOpen(false);

  return (
    <>
      {!wide && <div aria-hidden="true" onClick={close} className="fixed inset-0 z-30 animate-fade-in bg-scrim/60 backdrop-blur-[2px]" />}
      <aside
        ref={panelRef}
        aria-label="Workspace"
        style={wide ? { width, minWidth: PANEL_MIN_WIDTH, maxWidth: `calc(100% - ${CHAT_ROOM})` } : undefined}
        className={clsx(
          "flex shrink-0 animate-slide-in-right flex-col",
          wide
            ? "relative my-2 mr-2 rounded-lg border border-hairline bg-canvas"
            : "fixed inset-y-0 right-0 z-40 h-full w-full max-w-2xl border-l border-hairline bg-panel shadow-dialog",
        )}
      >
        {wide && <ResizeHandle />}
        <Tabs.Root value={tab} onValueChange={(value) => setWorkspaceTab(chat.id, value as WorkspaceTab)} className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-lg">
          <header className="app-drag-region flex h-14 shrink-0 items-center gap-2 border-b border-hairline pr-2 pl-3">
            <Tabs.List aria-label="Workspace" className="flex min-w-0 gap-0.5">
              {TABS.map((t) => (
                <Tabs.Trigger key={t.id} value={t.id} className={tabTrigger}>
                  {t.label}
                </Tabs.Trigger>
              ))}
            </Tabs.List>
            <div className="ml-auto flex shrink-0 items-center gap-1">
              <Tip content="Close (Esc)">
                <IconButton label="Close workspace panel" onClick={close}>
                  <X />
                </IconButton>
              </Tip>
            </div>
          </header>
          {info.status === "loading" ? (
            <div className="space-y-2 p-4" aria-busy="true" aria-label="Loading the workspace">
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/3" />
            </div>
          ) : info.status === "error" ? (
            <EmptyState size="sm" title="Couldn't open this chat's folder" description={info.message} />
          ) : !info.info.available ? (
            <EmptyState size="sm" title="This chat's folder isn't available here" description={info.info.reason} />
          ) : (
            TABS.map((t) => (
              <Tabs.Content key={t.id} value={t.id} className="flex min-h-0 flex-1 flex-col outline-none">
                <TabBody tab={t.id} chat={chat} info={info.info} />
              </Tabs.Content>
            ))
          )}
        </Tabs.Root>
      </aside>
    </>
  );
}
