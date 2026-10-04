import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import { Dialog } from "radix-ui";
import { CornerDownLeft, LayoutGrid, MessageCircleQuestion, Monitor, Moon, Search, Sun, X, type LucideIcon } from "lucide-react";
import { Kbd } from "../../src/components/ui/Kbd";
import { setThemePreference, useResolvedTheme, useThemePreference } from "../../src/lib/theme";
import { FAQ, questionJump } from "../apps/Help";
import { FEATURES, featureJump } from "../apps/WhatsInside";
import type { AppId } from "./ids";
import { APPS, APP_ORDER, AppIcon } from "./registry";

/** Something the shell can do from the launcher (arrange windows, switch appearance…). */
export type LauncherAction = { key: string; label: string; hint: string; icon: LucideIcon; terms?: string; run: () => void };

type Group = "Apps" | "Features" | "Questions" | "Actions";
type Item = { key: string; group: Group; label: string; hint: string; icon: ReactNode; terms: string; run: () => void };

const VERB: Record<Group, string> = { Apps: "Open", Features: "Show", Questions: "Ask", Actions: "Run" };
/** With a query, long groups show their best few. */
const CAP: Record<Group, number> = { Apps: 11, Features: 6, Questions: 4, Actions: 6 };

function Glyph({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="grid size-8 place-items-center rounded-lg border border-hairline bg-fill-subtle text-fg-muted">
      <Icon className="size-4" />
    </span>
  );
}

function buildItems(open: (id: AppId) => void, actions: LauncherAction[]): Item[] {
  return [
    ...APP_ORDER.map<Item>((id) => ({
      key: `app:${id}`,
      group: "Apps",
      label: APPS[id].name,
      hint: APPS[id].blurb,
      icon: <AppIcon id={id} size={32} />,
      terms: `${APPS[id].title} ${APPS[id].keywords ?? ""}`,
      run: () => open(id),
    })),
    ...FEATURES.map<Item>((feature) => ({
      key: `feature:${feature.title}`,
      group: "Features",
      label: feature.title,
      hint: feature.joke,
      icon: <Glyph icon={feature.icon} />,
      terms: `${feature.joke} ${feature.body}`,
      run: () => {
        featureJump.request(feature.title);
        open("features");
      },
    })),
    ...FAQ.map<Item>(({ q, a }) => ({
      key: `question:${q}`,
      group: "Questions",
      label: q,
      hint: a,
      icon: <Glyph icon={MessageCircleQuestion} />,
      terms: a,
      run: () => {
        questionJump.request(q);
        open("help");
      },
    })),
    ...actions.map<Item>((action) => ({
      key: `action:${action.key}`,
      group: "Actions",
      label: action.label,
      hint: action.hint,
      icon: <Glyph icon={action.icon} />,
      terms: action.terms ?? "",
      run: action.run,
    })),
  ];
}

/** 0 = no match; higher = better. Every word has to appear somewhere; label matches rank first. */
function score(item: Item, words: string[]): number {
  const label = item.label.toLowerCase();
  const haystack = `${label} ${item.terms.toLowerCase()}`;
  if (!words.every((word) => haystack.includes(word))) return 0;
  const query = words.join(" ");
  if (label.startsWith(query)) return 4;
  if (label.split(/[\s’']+/).some((part) => part.startsWith(words[0]!))) return 3;
  return label.includes(query) ? 2 : 1;
}

function filter(items: Item[], query: string): { name: Group; items: Item[] }[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const groups: Group[] = words.length ? ["Apps", "Features", "Questions", "Actions"] : ["Apps", "Actions"];
  return groups
    .map((name) => {
      const inGroup = items.filter((item) => item.group === name);
      if (!words.length) return { name, items: inGroup };
      const ranked = inGroup
        .map((item) => ({ item, rank: score(item, words) }))
        .filter(({ rank }) => rank > 0)
        .sort((a, b) => b.rank - a.rank)
        .slice(0, CAP[name])
        .map(({ item }) => item);
      return { name, items: ranked };
    })
    .filter((group) => group.items.length > 0);
}

/** The label with the typed query picked out (the one place the accent shows up in here). */
function Marked({ text, query }: { text: string; query: string }) {
  const at = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-sm bg-accent-soft text-fg">{text.slice(at, at + query.length)}</mark>
      {text.slice(at + query.length)}
    </>
  );
}

/**
 * "Search Tot's computer": every app, feature and FAQ answer in one list, plus a few shell actions. ⌘K or the
 * search button opens it; arrows move, Enter opens, Esc closes.
 */
export function Launcher({
  open,
  onOpenChange,
  openApp,
  actions,
  phone = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  openApp: (id: AppId) => void;
  actions: LauncherAction[];
  phone?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();

  const items = useMemo(() => buildItems(openApp, actions), [openApp, actions]);
  const groups = useMemo(() => filter(items, query.trim()), [items, query]);
  const flat = groups.flatMap((group) => group.items);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
  }, [open]);

  // Keep the highlighted row in view while arrowing through the list.
  useEffect(() => {
    const box = list.current;
    const row = box?.querySelector<HTMLElement>('[data-active="true"]');
    if (!box || !row) return;
    if (active === 0) box.scrollTop = 0;
    else if (row.offsetTop < box.scrollTop + 8) box.scrollTop = row.offsetTop - 36;
    else if (row.offsetTop + row.offsetHeight > box.scrollTop + box.clientHeight - 8)
      box.scrollTop = row.offsetTop + row.offsetHeight - box.clientHeight + 8;
  }, [active, groups]);

  function run(item: Item) {
    onOpenChange(false);
    item.run();
  }

  const optionId = (item: Item) => `${listId}-${item.key.replace(/[^a-z0-9]+/gi, "-")}`;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[10030] bg-scrim/20 data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in" />
        <Dialog.Content
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            (event.currentTarget as HTMLElement).querySelector("input")?.focus();
          }}
          className={clsx(
            "fixed left-1/2 z-[10031] flex w-[calc(100vw-24px)] max-w-150 -translate-x-1/2 flex-col overflow-hidden rounded-2xl border border-edge bg-elevated shadow-dialog",
            "data-[state=closed]:animate-pop-out data-[state=open]:animate-pop-in",
            phone ? "top-3 max-h-[min(620px,calc(100dvh-24px))]" : "top-[12vh] max-h-[min(560px,76vh)]",
          )}
        >
          <Dialog.Title className="sr-only">Search Tot's computer</Dialog.Title>
          <div className="flex h-14 shrink-0 items-center gap-3 border-b border-hairline px-4">
            <Search className="size-4.5 shrink-0 text-fg-subtle" />
            <input
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={(event) => {
                if (!flat.length) return;
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setActive((index) => (index + 1) % flat.length);
                } else if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setActive((index) => (index - 1 + flat.length) % flat.length);
                } else if (event.key === "Enter") {
                  event.preventDefault();
                  const item = flat[Math.min(active, flat.length - 1)];
                  if (item) run(item);
                }
              }}
              placeholder="Search apps, features and questions"
              aria-label="Search Tot's computer"
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-autocomplete="list"
              aria-activedescendant={flat[active] ? optionId(flat[active]!) : undefined}
              autoComplete="off"
              spellCheck={false}
              className="h-full min-w-0 flex-1 bg-transparent text-base text-fg outline-none placeholder:text-fg-subtle"
            />
            {phone ? (
              <Dialog.Close className="rounded-full px-2 py-1 text-sm font-medium text-fg-muted transition-colors hover:text-fg">
                Cancel
              </Dialog.Close>
            ) : (
              <Kbd keys={["esc"]} />
            )}
          </div>

          <div ref={list} id={listId} role="listbox" aria-label="Results" className="relative min-h-0 flex-1 overflow-y-auto p-2">
            {flat.length === 0 ? (
              <div className="px-6 py-12 text-center">
                <p className="text-sm text-fg">Nothing matches “{query.trim()}”</p>
                <p className="mt-1 text-xs text-fg-subtle">Try “slack”, “install” or “overnight”.</p>
              </div>
            ) : (
              groups.map((group) => (
                <div key={group.name} role="group" aria-label={group.name} className="pb-1">
                  <p className="group-label px-2.5 pt-2 pb-1.5">{group.name}</p>
                  {group.items.map((item) => {
                    const index = flat.indexOf(item);
                    const selected = index === active;
                    return (
                      <div
                        key={item.key}
                        id={optionId(item)}
                        role="option"
                        aria-selected={selected}
                        data-active={selected}
                        onMouseMove={() => index !== active && setActive(index)}
                        onClick={() => run(item)}
                        className={clsx(
                          "flex min-h-12 cursor-pointer items-center gap-3 rounded-xl px-2.5 py-1.5 transition-colors",
                          selected && "bg-selected",
                        )}
                      >
                        <span className="grid size-8 shrink-0 place-items-center">{item.icon}</span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-fg">
                            <Marked text={item.label} query={query.trim()} />
                          </span>
                          <span className="block truncate text-xs text-fg-subtle">{item.hint}</span>
                        </span>
                        {!phone && (
                          <span
                            aria-hidden="true"
                            className={clsx(
                              "flex shrink-0 items-center gap-1.5 text-xs text-fg-subtle transition-opacity",
                              selected ? "opacity-100" : "opacity-0",
                            )}
                          >
                            {VERB[item.group]} <CornerDownLeft className="size-3.5" />
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))
            )}
          </div>

          {!phone && (
            <div className="flex h-10 shrink-0 items-center gap-4 border-t border-hairline px-4 text-xs text-fg-subtle">
              <span className="flex items-center gap-1.5">
                <Kbd keys={["↑"]} />
                <Kbd keys={["↓"]} /> to move
              </span>
              <span className="flex items-center gap-1.5">
                <Kbd keys={["↵"]} /> to open
              </span>
              <span className="ml-auto tabular-nums">
                {query.trim()
                  ? `${flat.length} ${flat.length === 1 ? "result" : "results"}`
                  : `${APP_ORDER.length} apps · ${FEATURES.length} features · ${FAQ.length} answers`}
              </span>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The shell's own launcher actions: tidy up the windows and switch the appearance. */
export function useLauncherActions({
  arrange,
  closeAll,
  hasWindows,
}: {
  arrange?: () => void;
  closeAll?: () => void;
  hasWindows?: boolean;
}): LauncherAction[] {
  const preference = useThemePreference();
  const theme = useResolvedTheme();
  return useMemo(() => {
    const list: LauncherAction[] = [];
    if (arrange && hasWindows) {
      list.push({ key: "arrange", label: "Arrange windows", hint: "Tidy every open window", icon: LayoutGrid, terms: "tidy tile layout", run: arrange });
    }
    if (closeAll && hasWindows) {
      list.push({ key: "close-all", label: "Close all windows", hint: "Clear the desktop", icon: X, terms: "clear hide", run: closeAll });
    }
    const next = theme === "dark" ? "light" : "dark";
    list.push({
      key: "theme",
      label: next === "dark" ? "Dark mode" : "Light mode",
      hint: `Switch Tot's computer to ${next}`,
      icon: next === "dark" ? Moon : Sun,
      terms: "theme appearance color",
      run: () => setThemePreference(next),
    });
    if (preference !== "system") {
      list.push({
        key: "system",
        label: "Match system appearance",
        hint: "Follow your device's light or dark setting",
        icon: Monitor,
        terms: "theme appearance auto",
        run: () => setThemePreference("system"),
      });
    }
    return list;
  }, [arrange, closeAll, hasWindows, preference, theme]);
}
