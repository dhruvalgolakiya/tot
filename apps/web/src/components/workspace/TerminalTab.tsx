import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Plus, SquareTerminal, X } from "lucide-react";
import type { Conversation } from "@tot/shared/types";
import type { TerminalEvent, WorkspaceInfo, WorkspaceTerminal } from "@tot/shared/workspace";
import { errorMessage } from "../../lib/api";
import { useResolvedTheme, type ResolvedTheme } from "../../lib/theme";
import { workspaceApi } from "../../lib/workspace";
import { Callout } from "../ui/Callout";
import { EmptyState } from "../ui/EmptyState";
import { IconButton } from "../ui/IconButton";
import { Skeleton } from "../ui/Skeleton";
import { Tip } from "../ui/Tip";

/** The panel's canvas behind the text, and ANSI colors readable on it, per theme. */
const THEMES: Record<ResolvedTheme, ITheme> = {
  dark: {
    background: "#212121", foreground: "#ececec", cursor: "#ececec", cursorAccent: "#212121", selectionBackground: "#ffffff33",
    black: "#3b3b3b", red: "#ff7b72", green: "#7ee787", yellow: "#e3b341", blue: "#79c0ff", magenta: "#d2a8ff", cyan: "#76e3ea", white: "#d9d9d9",
    brightBlack: "#8b949e", brightRed: "#ffa198", brightGreen: "#a6f0b0", brightYellow: "#f2cc60", brightBlue: "#a5d6ff", brightMagenta: "#e2c5ff", brightCyan: "#b3f0ff", brightWhite: "#ffffff",
  },
  light: {
    background: "#ffffff", foreground: "#1f1f1f", cursor: "#1f1f1f", cursorAccent: "#ffffff", selectionBackground: "#0000001f",
    black: "#1f1f1f", red: "#cf222e", green: "#116329", yellow: "#9a6700", blue: "#0550ae", magenta: "#8250df", cyan: "#1b7c83", white: "#6e7781",
    brightBlack: "#57606a", brightRed: "#a40e26", brightGreen: "#1a7f37", brightYellow: "#7d4e00", brightBlue: "#0969da", brightMagenta: "#a475f9", brightCyan: "#3192aa", brightWhite: "#8c959f",
  },
};
const FONT = '"Geist Mono", ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace';

/** The terminal each chat showed last. */
const lastShown = new Map<string, string>();

const post = (path: string, body: unknown) =>
  fetch(`/api${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/**
 * One terminal: xterm.js on the server's shell, its output over a stream (what it printed lately first), keys
 * sent as they're typed, its size following the panel's. Escape and every other key go to the shell.
 */
function TerminalView({
  terminal,
  visible,
  theme,
  onExit,
}: {
  terminal: WorkspaceTerminal;
  visible: boolean;
  theme: ResolvedTheme;
  onExit: (exitCode: number) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<() => void>(() => {});
  const onExitRef = useRef(onExit);
  onExitRef.current = onExit;

  useEffect(() => {
    const element = host.current!;
    const term = new Terminal({ fontFamily: FONT, fontSize: 12, lineHeight: 1.25, cursorBlink: true, scrollback: 5000, theme: THEMES[theme], macOptionIsMeta: true });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon((_event, uri) => window.open(uri, "_blank", "noopener,noreferrer")));
    termRef.current = term;
    let disposed = false;

    // Keys go out in order, a few at a time.
    let queued = "";
    let sending: Promise<unknown> = Promise.resolve();
    const flush = () => {
      if (!queued) return;
      const data = queued;
      queued = "";
      sending = sending.then(() => post(`/workspace/terminals/${terminal.id}/input`, { data }).catch(() => {}));
    };
    const typed = term.onData((data) => {
      queued += data;
      queueMicrotask(flush);
    });

    let size = { cols: 0, rows: 0 };
    let resizeTimer = 0;
    const refit = () => {
      if (disposed || !element.offsetWidth || !element.offsetHeight) return;
      fit.fit();
      if (term.cols === size.cols && term.rows === size.rows) return;
      size = { cols: term.cols, rows: term.rows };
      window.clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => void post(`/workspace/terminals/${terminal.id}/resize`, size).catch(() => {}), 80);
    };
    fitRef.current = refit;
    const observer = new ResizeObserver(refit);

    let source: EventSource | null = null;
    // The font first, so xterm measures its cells in the right one.
    void document.fonts.load(`12px "Geist Mono"`).finally(() => {
      if (disposed) return;
      term.open(element);
      refit();
      observer.observe(element);
      source = new EventSource(`/api/workspace/terminals/${encodeURIComponent(terminal.id)}/stream`);
      let dropped = false;
      source.onopen = () => {
        // Back after a dropped connection: the server sends what it printed lately again, from a clean screen.
        if (dropped) term.reset();
        dropped = false;
      };
      source.onerror = () => {
        dropped = true;
      };
      source.onmessage = (message) => {
        if (!message.data) return;
        const event = JSON.parse(message.data) as TerminalEvent;
        if (event.type === "output") term.write(event.data);
        else {
          term.write(`\r\n\x1b[2m[The shell exited with code ${event.exitCode}.]\x1b[0m\r\n`);
          source?.close();
          onExitRef.current(event.exitCode);
        }
      };
    });

    return () => {
      disposed = true;
      flush();
      window.clearTimeout(resizeTimer);
      observer.disconnect();
      source?.close();
      typed.dispose();
      term.dispose();
      termRef.current = null;
    };
  }, [terminal.id]);

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = THEMES[theme];
  }, [theme]);

  useEffect(() => {
    if (!visible) return;
    fitRef.current();
    termRef.current?.focus();
  }, [visible]);

  return <div ref={host} data-own-escape className={clsx("absolute inset-0 py-1 pl-2", !visible && "invisible")} />;
}

/**
 * Terminals in the chat's folder: tabs for each (new with +, closed with ×), one shown at a time. They're the
 * server's, so they keep running when the panel closes or another chat opens, and come back with what they
 * printed. The first opens by itself.
 */
export function TerminalTab({ chat, info }: { chat: Conversation; info: WorkspaceInfo }) {
  const theme = useResolvedTheme();
  const [list, setList] = useState<WorkspaceTerminal[] | null>(null);
  const [active, setActive] = useState<string | null>(() => lastShown.get(chat.id) ?? null);
  const [problem, setProblem] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const started = useRef(false);

  const show = useCallback(
    (id: string | null) => {
      if (id) lastShown.set(chat.id, id);
      else lastShown.delete(chat.id);
      setActive(id);
    },
    [chat.id],
  );

  const openNew = useCallback(async () => {
    setOpening(true);
    try {
      const terminal = await workspaceApi.openTerminal(chat.id);
      setList((current) => [...(current ?? []), terminal]);
      setProblem(null);
      show(terminal.id);
    } catch (error) {
      setProblem(errorMessage(error));
    } finally {
      setOpening(false);
    }
  }, [chat.id, show]);

  useEffect(() => {
    if (!info.canTerminal) return;
    let live = true;
    workspaceApi.terminals(chat.id).then(
      (terminals) => {
        if (!live) return;
        setList(terminals);
        if (terminals.length === 0 && !started.current) {
          started.current = true;
          void openNew();
        }
      },
      (error) => live && setProblem(errorMessage(error)),
    );
    return () => {
      live = false;
    };
  }, [chat.id, info.canTerminal, openNew]);

  const close = (id: string) => {
    void workspaceApi.closeTerminal(id).catch(() => {});
    const remaining = (list ?? []).filter((terminal) => terminal.id !== id);
    setList(remaining);
    if (active === id) show(remaining.at(-1)?.id ?? null);
  };

  if (!info.canTerminal) {
    return <EmptyState size="sm" icon={<SquareTerminal />} title="Terminals open on this Mac" description="Or on a device where you're signed in with your password." />;
  }

  const terminals = list ?? [];
  const shown = terminals.find((terminal) => terminal.id === active)?.id ?? terminals.at(-1)?.id ?? null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-hairline px-1.5" role="tablist" aria-label="Terminals">
        {terminals.map((terminal) => (
          <div key={terminal.id} className={clsx("group flex h-7 items-center rounded-md pl-2.5 transition-colors", terminal.id === shown ? "bg-selected text-fg" : "text-fg-muted hover:bg-hover hover:text-fg")}>
            <button type="button" role="tab" aria-selected={terminal.id === shown} onClick={() => show(terminal.id)} className="text-ui">
              {terminal.title}
              {terminal.exitCode !== null && <span className="text-fg-subtle"> · exited</span>}
            </button>
            <button
              type="button"
              aria-label={`Close ${terminal.title}`}
              onClick={() => close(terminal.id)}
              className="ml-1 grid size-5 place-items-center rounded text-fg-subtle opacity-0 transition-opacity group-hover:opacity-100 hover:text-fg focus-visible:opacity-100 pointer-coarse:opacity-100"
            >
              <X className="size-3" />
            </button>
          </div>
        ))}
        <Tip content="New terminal">
          <IconButton size="sm" label="New terminal" onClick={() => void openNew()} disabled={opening}>
            <Plus />
          </IconButton>
        </Tip>
      </div>
      {problem && (
        <div className="shrink-0 p-2">
          <Callout tone="danger">{problem}</Callout>
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        {list === null ? (
          <div className="space-y-2 p-3" aria-busy="true" aria-label="Opening a terminal">
            <Skeleton className="h-3.5 w-1/3" />
          </div>
        ) : terminals.length === 0 && !opening ? (
          <EmptyState size="sm" icon={<SquareTerminal />} title="No terminals open" description="Open one with + to run commands in this folder." />
        ) : (
          terminals.map((terminal) => (
            <TerminalView
              key={terminal.id}
              terminal={terminal}
              visible={terminal.id === shown}
              theme={theme}
              onExit={(exitCode) => setList((current) => (current ?? []).map((each) => (each.id === terminal.id ? { ...each, exitCode } : each)))}
            />
          ))
        )}
      </div>
    </div>
  );
}
