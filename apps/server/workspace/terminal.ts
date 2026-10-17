import { randomUUID } from "node:crypto";
import { accessSync, chmodSync, constants, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import type { TerminalEvent, WorkspaceTerminal } from "@tot/shared/workspace";
import { HttpError } from "../agent/orchestrator.ts";
import { appEvents } from "../app-events.ts";
import { hostGitEnv } from "../git-env.ts";
import { chatSpaces, type ChatSpace } from "./root.ts";

/**
 * Terminals in a chat's folder: a real shell (the user's own, as a login shell) on a pseudo-terminal, kept by
 * the server so it outlives the panel and the chat being switched away from; what it printed lately is
 * replayed to whoever opens it next. A terminal ends when it's closed, when its shell exits, when the chat is
 * deleted or no longer has that folder, and when TOT stops. It's the user's shell, not an agent's: it runs
 * outside the agents' sandbox, so only this computer and the owner signed in elsewhere may open one (routes.ts).
 */

type Pty = import("node-pty").IPty;

const SCROLLBACK_CHARS = 256 * 1024;
const MAX_PER_CHAT = 8;
const MAX_TOTAL = 32;
/** Output that arrives together goes out together. */
const BATCH_MS = 8;

interface Session {
  info: WorkspaceTerminal;
  root: string;
  pty: Pty;
  scrollback: string;
  pending: string;
  flush: NodeJS.Timeout | null;
  listeners: Set<(event: TerminalEvent) => void>;
}

const sessions = new Map<string, Session>();
let loaded: Promise<typeof import("node-pty")> | null = null;

/**
 * node-pty, loaded the first time a terminal opens. Its prebuilt helper sometimes comes out of npm without its
 * execute bit, which makes every spawn fail; it gets it back here when the folder allows.
 */
function nodePty(): Promise<typeof import("node-pty")> {
  loaded ??= (async () => {
    try {
      const require = createRequire(import.meta.url);
      const root = dirname(require.resolve("node-pty/package.json"));
      for (const helper of [join(root, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"), join(root, "build", "Release", "spawn-helper")]) {
        if (!existsSync(helper)) continue;
        try {
          accessSync(helper, constants.X_OK);
        } catch {
          chmodSync(helper, 0o755);
        }
      }
    } catch {
      // Spawning reports it, if it matters.
    }
    return import("node-pty");
  })();
  loaded.catch(() => (loaded = null));
  return loaded;
}

/** The user's environment for their shell, minus TOT's own settings and git variables pointing elsewhere. */
function shellEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(hostGitEnv())) {
    if (value === undefined || /^(TOT_|ELECTRON_|npm_)/.test(key) || key === "NODE_OPTIONS") continue;
    env[key] = value;
  }
  return { ...env, TERM: "xterm-256color", COLORTERM: "truecolor", LANG: env.LANG || "en_US.UTF-8" };
}

function emit(session: Session, event: TerminalEvent): void {
  for (const listener of [...session.listeners]) listener(event);
}

function end(session: Session): void {
  if (!sessions.delete(session.info.id)) return;
  if (session.flush) clearTimeout(session.flush);
  try {
    session.pty.kill();
  } catch {
    // Already gone.
  }
}

export const terminals = {
  async open(space: ChatSpace, { cols, rows }: { cols?: unknown; rows?: unknown }): Promise<WorkspaceTerminal> {
    const mine = [...sessions.values()].filter((session) => session.info.conversationId === space.chat.id);
    if (mine.length >= MAX_PER_CHAT || sessions.size >= MAX_TOTAL) throw new HttpError(409, "There are too many terminals open. Close one first.");
    let pty: typeof import("node-pty");
    try {
      pty = await nodePty();
    } catch (err) {
      throw new HttpError(409, `Terminals can't start on this Mac: ${err instanceof Error ? err.message : String(err)}`);
    }
    const shell = process.env.SHELL && existsSync(process.env.SHELL) ? process.env.SHELL : "/bin/zsh";
    const size = (value: unknown, fallback: number, max: number) => (Number.isInteger(value) ? Math.min(max, Math.max(2, value as number)) : fallback);
    let child: Pty;
    try {
      child = pty.spawn(shell, ["-l"], {
        name: "xterm-256color",
        cols: size(cols, 80, 500),
        rows: size(rows, 24, 200),
        cwd: space.root,
        env: shellEnv(),
      });
    } catch (err) {
      throw new HttpError(409, `The terminal didn't start: ${err instanceof Error ? err.message : String(err)}`);
    }
    const info: WorkspaceTerminal = {
      id: randomUUID(),
      conversationId: space.chat.id,
      title: `${basename(shell)} ${mine.length + 1}`,
      createdAt: Date.now(),
      exitCode: null,
    };
    const session: Session = { info, root: space.root, pty: child, scrollback: "", pending: "", flush: null, listeners: new Set() };
    sessions.set(info.id, session);
    child.onData((data) => {
      session.scrollback = (session.scrollback + data).slice(-SCROLLBACK_CHARS);
      session.pending += data;
      session.flush ??= setTimeout(() => {
        session.flush = null;
        const chunk = session.pending;
        session.pending = "";
        emit(session, { type: "output", data: chunk });
      }, BATCH_MS);
    });
    child.onExit(({ exitCode }) => {
      if (session.flush) {
        clearTimeout(session.flush);
        session.flush = null;
        if (session.pending) emit(session, { type: "output", data: session.pending });
      }
      info.exitCode = exitCode;
      emit(session, { type: "exit", exitCode });
      sessions.delete(info.id);
    });
    return info;
  },

  list(chatId: string): WorkspaceTerminal[] {
    return [...sessions.values()].filter((session) => session.info.conversationId === chatId).map((session) => session.info);
  },

  /** The terminal, for a caller allowed terminals; 404 once it's gone. */
  get(id: string): Session {
    const session = sessions.get(id);
    if (!session) throw new HttpError(404, "That terminal has closed.");
    return session;
  },

  /** What it printed lately, then everything it prints from now on. */
  subscribe(id: string, listener: (event: TerminalEvent) => void): () => void {
    const session = terminals.get(id);
    if (session.scrollback) listener({ type: "output", data: session.scrollback });
    session.listeners.add(listener);
    return () => session.listeners.delete(listener);
  },

  write(id: string, data: unknown): void {
    if (typeof data !== "string" || data.length > 64 * 1024) throw new HttpError(400, "Send text to the terminal.");
    terminals.get(id).pty.write(data);
  },

  resize(id: string, cols: unknown, rows: unknown): void {
    if (!Number.isInteger(cols) || !Number.isInteger(rows)) throw new HttpError(400, "A terminal's size is whole columns and rows.");
    terminals.get(id).pty.resize(Math.min(500, Math.max(2, cols as number)), Math.min(200, Math.max(2, rows as number)));
  },

  close(id: string): void {
    const session = sessions.get(id);
    if (session) end(session);
  },

  closeChat(chatId: string): void {
    for (const session of [...sessions.values()]) if (session.info.conversationId === chatId) end(session);
  },

  closeAll(): void {
    for (const session of [...sessions.values()]) end(session);
  },

  count: () => sessions.size,
};

// A chat deleted, or no longer working in that folder (its worktree removed, moved to another project): its terminals end.
appEvents.subscribe((event) => {
  if (event.type === "conversation-deleted") terminals.closeChat(event.conversationId);
  else if (event.type === "conversation") {
    const open = [...sessions.values()].filter((session) => session.info.conversationId === event.conversation.id);
    if (open.length && chatSpaces.tryResolve(event.conversation.id)?.root !== open[0]!.root) terminals.closeChat(event.conversation.id);
  }
});
process.once("exit", () => terminals.closeAll());
