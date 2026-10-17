import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import clsx from "clsx";
import { Dialog } from "radix-ui";
import {
  Archive,
  Bot,
  BookOpen,
  Clock,
  FolderPlus,
  LayoutGrid,
  ListChecks,
  LoaderCircle,
  MessageSquare,
  Moon,
  PanelLeft,
  Settings,
  SquarePen,
  Sun,
  TextQuote,
  UsersRound,
} from "lucide-react";
import type { MessageSearchHit, SnippetPart } from "@tot/shared/types";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { api } from "../../lib/api";
import { conversationTitle, isHiddenChat } from "../../lib/conversations";
import { relativeTime } from "../../lib/format";
import { jumpToMessage } from "../../lib/jump";
import { setArchivedOpen } from "../../lib/organize";
import { highlightParts, matchScore, queryWords, setPaletteOpen, usePalette } from "../../lib/palette";
import { PROJECT_ICONS, setNewProjectOpen, useProjects } from "../../lib/projects";
import { setThemePreference, useResolvedTheme } from "../../lib/theme";
import {
  goToSettings,
  navigateToAgentHome,
  navigateToConversation,
  navigateToCrew,
  navigateToMission,
  navigateToProject,
  navigateToWiki,
  selectActiveAgentId,
  selectAgent,
  setNewAgentDialogOpen,
  toggleSidebar,
  useStore,
} from "../../store";
import { Mascot } from "../mascot/Mascot";
import { SETTINGS_SECTIONS } from "../settings/settingsSections";
import { Kbd } from "../ui/Kbd";

interface Item {
  key: string;
  icon: ReactNode;
  title: ReactNode;
  /** A second line: a message hit's snippet. */
  detail?: ReactNode;
  meta?: ReactNode;
  run: () => void;
}

interface Group {
  label: string;
  items: Item[];
  /** How well its best item matched, to put the likeliest group first. */
  score: number;
}

interface Action {
  id: string;
  label: string;
  /** Other words it's found by. */
  keywords?: string;
  icon: ReactNode;
  keys?: string[];
  run: () => void;
}

const RECENT_CHATS = 8;
const MAX_CHATS = 6;
const MAX_OTHERS = 4;
/** Message search starts at this many characters; fewer match half of every chat. */
const MIN_SEARCH_CHARS = 2;

/** ⌘K: one box to find any chat (by title or by what was said in it), project, agent or setting, or to run a command. */
export function CommandPalette() {
  const open = usePalette((s) => s.open);
  // Each opening starts afresh: an empty query, the recent chats.
  const [session, setSession] = useState({ open, count: 0 });
  if (session.open !== open) setSession({ open, count: open ? session.count + 1 : session.count });
  const ran = useRef(false);
  return (
    <Dialog.Root open={open} onOpenChange={setPaletteOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-scrim/60 backdrop-blur-[2px] data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in" />
        <div className="pointer-events-none fixed inset-0 z-50 flex items-start justify-center p-3 pt-[10vh] sm:p-6 sm:pt-[14vh]">
          <Dialog.Content
            aria-describedby={undefined}
            onOpenAutoFocus={() => (ran.current = false)}
            // What was picked moves focus itself (a new chat's composer); otherwise it goes back where it was.
            onCloseAutoFocus={(event) => ran.current && event.preventDefault()}
            className="pointer-events-auto flex max-h-[min(72dvh,560px)] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-hairline bg-elevated shadow-dialog outline-none data-[state=closed]:animate-pop-out data-[state=open]:animate-pop-in"
          >
            <Dialog.Title className="sr-only">Search chats and commands</Dialog.Title>
            <PaletteBody
              key={session.count}
              onRun={(run) => {
                ran.current = true;
                setPaletteOpen(false);
                run();
              }}
            />
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function PaletteBody({ onRun }: { onRun: (run: () => void) => void }) {
  const [query, setQuery] = useState("");
  const words = useMemo(() => queryWords(query), [query]);
  const actions = useActions();
  const { hits, searching } = useMessageHits(query);
  const groups = usePaletteGroups(words, actions, hits);
  const items = useMemo(() => groups.flatMap((group) => group.items), [groups]);

  // The selection follows its item, not its place: message hits arriving late don't move it.
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selected = items.find((item) => item.key === selectedKey) ?? items[0];
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!selected) return;
    listRef.current?.querySelector(`[data-key="${CSS.escape(selected.key)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const move = (by: number) => {
    if (!items.length) return;
    const at = selected ? items.indexOf(selected) : -1;
    setSelectedKey(items[(at + by + items.length) % items.length]!.key);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    const ctrlOnly = event.ctrlKey && !event.metaKey && !event.altKey;
    if (event.key === "ArrowDown" || (ctrlOnly && event.key === "n")) {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowUp" || (ctrlOnly && event.key === "p")) {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Enter" && selected) {
      event.preventDefault();
      onRun(selected.run);
    }
  };

  return (
    <>
      <div className="flex shrink-0 items-center gap-2.5 border-b border-hairline px-4">
        <input
          autoFocus
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-results"
          aria-activedescendant={selected ? `palette-${selected.key}` : undefined}
          aria-label="Search chats and commands"
          placeholder="Search chats, messages and commands"
          autoComplete="off"
          spellCheck={false}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelectedKey(null);
          }}
          onKeyDown={onKeyDown}
          className="h-12 min-w-0 flex-1 bg-transparent text-chat text-fg outline-none placeholder:text-fg-subtle"
        />
        {searching && <LoaderCircle aria-label="Searching messages" className="size-4 shrink-0 animate-spin text-fg-subtle" />}
      </div>

      <div ref={listRef} id="palette-results" role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto p-2">
        {items.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-fg-subtle">
            {searching ? "Searching…" : `Nothing matches “${query.trim()}”`}
          </p>
        ) : (
          groups.map((group) => (
            <div key={group.label} role="group" aria-label={group.label} className="mb-1 last:mb-0">
              <div className="group-label px-2.5 pt-2 pb-1">{group.label}</div>
              {group.items.map((item) => (
                <PaletteRow
                  key={item.key}
                  item={item}
                  selected={item === selected}
                  onSelect={() => setSelectedKey(item.key)}
                  onRun={() => onRun(item.run)}
                />
              ))}
            </div>
          ))
        )}
      </div>

      <div className="hidden shrink-0 items-center gap-4 border-t border-hairline px-4 py-2 text-xs text-fg-subtle sm:flex">
        <span className="flex items-center gap-1.5">
          <Kbd keys={["↑"]} />
          <Kbd keys={["↓"]} /> to move
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd keys={["↵"]} /> to open
        </span>
        <span className="flex items-center gap-1.5">
          <Kbd keys={["esc"]} /> to close
        </span>
      </div>
    </>
  );
}

function PaletteRow({ item, selected, onSelect, onRun }: { item: Item; selected: boolean; onSelect: () => void; onRun: () => void }) {
  return (
    <div
      id={`palette-${item.key}`}
      data-key={item.key}
      role="option"
      aria-selected={selected}
      // Pointer moves, not enters: a list scrolled by the keyboard under a still pointer keeps its selection.
      onPointerMove={() => !selected && onSelect()}
      onClick={onRun}
      className={clsx(
        "flex min-h-9 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-sm text-fg select-none",
        selected && "bg-hover",
      )}
    >
      <span className={clsx("grid size-4 shrink-0 place-items-center [&_svg]:size-4", item.detail && "self-start pt-0.5", selected ? "text-fg" : "text-fg-muted")}>
        {item.icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate">{item.title}</span>
        {item.detail && <span className="mt-0.5 line-clamp-2 block text-xs leading-snug text-fg-subtle">{item.detail}</span>}
      </span>
      {item.meta && <span className="flex shrink-0 items-center gap-1.5 self-start pt-0.5 text-xs text-fg-subtle tabular-nums">{item.meta}</span>}
    </div>
  );
}

/** Matched pieces of a title or snippet, highlighted. */
function Highlighted({ parts }: { parts: SnippetPart[] }) {
  return (
    <>
      {parts.map((part, index) =>
        part.match ? (
          <mark key={index} className="rounded-sm bg-accent-soft text-fg">
            {part.text}
          </mark>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}

function useActions(): Action[] {
  const theme = useResolvedTheme();
  return useMemo(() => {
    const activeAgentId = () => selectActiveAgentId(useStore.getState());
    const nextTheme = theme === "dark" ? "light" : "dark";
    return [
      {
        id: "new-chat",
        label: "New chat",
        keywords: "start compose",
        icon: <SquarePen />,
        keys: ["mod", "shift", "O"],
        run: () => {
          const agentId = activeAgentId();
          if (agentId) navigateToAgentHome(agentId);
          requestAnimationFrame(() => document.getElementById("composer-input")?.focus());
        },
      },
      {
        id: "mission",
        label: "Mission control",
        keywords: "tasks board queue",
        icon: <LayoutGrid />,
        keys: ["mod", "shift", "M"],
        run: () => {
          const s = useStore.getState();
          navigateToMission(s.page === "project" ? s.projectId : s.page === "mission" ? s.missionProjectId : null);
        },
      },
      {
        id: "theme",
        label: `Switch to ${nextTheme} mode`,
        keywords: "toggle theme appearance dark light",
        icon: theme === "dark" ? <Sun /> : <Moon />,
        run: () => setThemePreference(nextTheme),
      },
      { id: "settings", label: "Settings", keywords: "preferences options", icon: <Settings />, keys: ["mod", ","], run: () => goToSettings() },
      { id: "new-agent", label: "New agent", keywords: "create", icon: <Bot />, run: () => setNewAgentDialogOpen(true) },
      { id: "new-project", label: "New project", keywords: "create", icon: <FolderPlus />, run: () => setNewProjectOpen(true) },
      { id: "crew", label: "Your crew", keywords: "agents", icon: <UsersRound />, run: navigateToCrew },
      {
        id: "knowledge",
        label: "Knowledge",
        keywords: "wiki brain notebook pages",
        icon: <BookOpen />,
        run: () => {
          const agentId = activeAgentId();
          if (agentId) navigateToWiki(agentId);
        },
      },
      { id: "sidebar", label: "Toggle sidebar", keywords: "hide show panel", icon: <PanelLeft />, run: toggleSidebar },
      { id: "archived", label: "Archived chats", keywords: "snoozed hidden", icon: <Archive />, run: () => setArchivedOpen(true) },
    ];
  }, [theme]);
}

/** Messages that match the query (searched once it has paused for a moment), and whether that search is under way. */
function useMessageHits(query: string): { hits: MessageSearchHit[]; searching: boolean } {
  const typed = query.trim();
  const q = useDebouncedValue(typed, 150);
  // Each opening searches afresh (chats change), but going back to an earlier query while typing doesn't.
  const cache = useRef(new Map<string, MessageSearchHit[]>());
  const [found, setFound] = useState<{ q: string; hits: MessageSearchHit[] }>({ q: "", hits: [] });
  useEffect(() => {
    if (q.length < MIN_SEARCH_CHARS) return;
    const cached = cache.current.get(q);
    if (cached) return setFound({ q, hits: cached });
    let cancelled = false;
    const settle = (hits: MessageSearchHit[]) => {
      cache.current.set(q, hits);
      if (!cancelled) setFound({ q, hits });
    };
    api.search(q, { limit: 20 }).then((results) => settle(results.messages), () => settle([]));
    return () => {
      cancelled = true;
    };
  }, [q]);
  if (typed.length < MIN_SEARCH_CHARS) return { hits: [], searching: false };
  // An older query's hits stay up until the new ones come: less flicker while typing.
  return { hits: found.hits, searching: found.q !== typed };
}

function usePaletteGroups(words: string[], actions: Action[], messageHits: MessageSearchHit[]): Group[] {
  const conversations = useStore((s) => s.conversations);
  const agents = useStore((s) => s.agents);
  const projects = useProjects((s) => s.projects);

  return useMemo(() => {
    const agentName = new Map(agents.map((a) => [a.id, a.name]));
    const manyAgents = agents.length > 1;
    const chatItem = (c: (typeof conversations)[number]): Item => ({
      key: `chat:${c.id}`,
      icon: c.kind === "task" ? <ListChecks /> : c.routineId ? <Clock /> : <MessageSquare />,
      title: <Highlighted parts={highlightParts(conversationTitle(c), words)} />,
      meta: (
        <>
          {c.archivedAt ? <span>Archived</span> : isHiddenChat(c) && <span>Snoozed</span>}
          {manyAgents && <span className="max-w-24 truncate">{agentName.get(c.agentId)}</span>}
          <span>{relativeTime(c.updatedAt)}</span>
        </>
      ),
      run: () => navigateToConversation(c.id),
    });
    const actionItem = (action: Action): Item => ({
      key: `action:${action.id}`,
      icon: action.icon,
      title: <Highlighted parts={highlightParts(action.label, words)} />,
      meta: action.keys && <Kbd keys={action.keys} />,
      run: action.run,
    });

    if (!words.length) {
      const recent = conversations.filter((c) => c.kind === "chat" && !c.lead && !isHiddenChat(c)).slice(0, RECENT_CHATS);
      return [
        ...(recent.length ? [{ label: "Recent chats", items: recent.map(chatItem), score: 0 }] : []),
        { label: "Commands", items: actions.map(actionItem), score: 0 },
      ];
    }

    const ranked = <T,>(list: T[], text: (item: T) => string, max: number, tiebreak?: (a: T, b: T) => number) =>
      list
        .map((item) => ({ item, score: matchScore(text(item), words) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score || (tiebreak ? tiebreak(a.item, b.item) : 0))
        .slice(0, max);
    const group = <T,>(label: string, entries: { item: T; score: number }[], toItem: (item: T) => Item): Group[] =>
      entries.length ? [{ label, items: entries.map((e) => toItem(e.item)), score: entries[0]!.score }] : [];

    const chats = ranked(conversations, conversationTitle, MAX_CHATS, (a, b) => b.updatedAt - a.updatedAt);
    const liveProjects = ranked(
      projects.filter((p) => !p.archived),
      (p) => p.name,
      MAX_OTHERS,
    );
    const agentMatches = ranked(agents, (a) => a.name, MAX_OTHERS);
    const actionMatches = ranked(actions, (a) => `${a.label} ${a.keywords ?? ""}`, MAX_OTHERS);
    const sections = ranked(SETTINGS_SECTIONS, (s) => `${s.label} settings`, MAX_OTHERS);

    const named = [
      ...group("Chats", chats, chatItem),
      ...group("Projects", liveProjects, (p) => {
        const Icon = PROJECT_ICONS[p.kind];
        return {
          key: `project:${p.id}`,
          icon: <Icon />,
          title: <Highlighted parts={highlightParts(p.name, words)} />,
          run: () => navigateToProject(p.id),
        };
      }),
      ...group("Agents", agentMatches, (a) => ({
        key: `agent:${a.id}`,
        icon: <Mascot spec={a.mascot} size={18} title={a.name} />,
        title: <Highlighted parts={highlightParts(a.name, words)} />,
        meta: a.tagline ? <span className="max-w-40 truncate">{a.tagline}</span> : undefined,
        run: () => selectAgent(a.id),
      })),
      ...group("Commands", actionMatches, actionItem),
      ...group("Settings", sections, (s) => {
        const Icon = s.icon;
        return {
          key: `settings:${s.id}`,
          icon: <Icon />,
          title: <Highlighted parts={highlightParts(s.label, words)} />,
          run: () => goToSettings(s.id),
        };
      }),
    ].sort((a, b) => b.score - a.score);

    // Message hits come last: they arrive after the rest, and below it they don't push anything around.
    const messages: Group[] = messageHits.length
      ? [
          {
            label: "Messages",
            score: 0,
            items: messageHits.map((hit) => ({
              key: `message:${hit.messageId}`,
              icon: <TextQuote />,
              title: <span className="text-fg">{hit.title.trim() || "New chat"}</span>,
              detail: (
                <>
                  {hit.role === "assistant" && manyAgents && <span>{agentName.get(hit.agentId) ?? "Agent"}: </span>}
                  {hit.role === "user" && <span>You: </span>}
                  <Highlighted parts={hit.snippet} />
                </>
              ),
              meta: <span>{relativeTime(hit.createdAt)}</span>,
              run: () => jumpToMessage(hit.conversationId, hit.messageId, words),
            })),
          },
        ]
      : [];
    return [...named, ...messages];
  }, [conversations, agents, projects, actions, words, messageHits]);
}
