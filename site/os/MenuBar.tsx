import { Fragment, type ReactNode } from "react";
import clsx from "clsx";
import { Menubar } from "radix-ui";
import { Check, Search } from "lucide-react";
import { isMac } from "../../src/lib/format";
import { setThemePreference, useThemePreference, type ThemePreference } from "../../src/lib/theme";
import { ThemeToggle, useClock } from "../ui";
import { ClaudeMark, OpenAIMark } from "./BrandMarks";
import { useOs } from "./context";
import { APPS, APP_ORDER, AppIcon } from "./registry";

const MOD = isMac ? "⌘" : "Ctrl ";

const APPEARANCE: { value: ThemePreference; label: string }[] = [
  { value: "system", label: "Match system" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** The top bar: real menus on the left (every item does something), status and the CTA on the right. */
export function MenuBar({
  height,
  hasWindows,
  onArrange,
  onCloseWindow,
  onCloseAll,
}: {
  height: number;
  hasWindows: boolean;
  onArrange: () => void;
  onCloseWindow: () => void;
  onCloseAll: () => void;
}) {
  const now = useClock();
  const { open, search } = useOs();
  const appearance = useThemePreference();

  return (
    <header
      className="glass fixed inset-x-0 top-0 z-[10000] flex items-center gap-1 border-b border-hairline px-2 text-ui"
      style={{ height }}
    >
      <Menubar.Root className="flex items-center gap-0.5" aria-label="Menu bar">
        <Menu
          label="TOT"
          trigger={
            <>
              <img src="/tot.svg" alt="" className="size-4 rounded" />
              <span className="font-semibold text-fg">TOT</span>
            </>
          }
        >
          <Item onSelect={() => open("readme")}>About TOT</Item>
          <Item onSelect={() => open("terminal")}>Get TOT…</Item>
          <Menubar.Separator className="menu-separator" />
          <Item onSelect={search} shortcut={`${MOD}K`}>
            Search…
          </Item>
        </Menu>

        <Menu label="Apps" trigger="Apps">
          {APP_ORDER.map((id) => (
            <Fragment key={id}>
              {id === "readme" && <Menubar.Separator className="menu-separator" />}
              <Item icon={<AppIcon id={id} size={18} />} onSelect={() => open(id)}>
                {APPS[id].name}
              </Item>
            </Fragment>
          ))}
        </Menu>

        <Menu label="View" trigger="View">
          <Item onSelect={onArrange} disabled={!hasWindows}>
            Arrange windows
          </Item>
          <Item onSelect={onCloseWindow} disabled={!hasWindows} shortcut="Esc">
            Close window
          </Item>
          <Item onSelect={onCloseAll} disabled={!hasWindows}>
            Close all windows
          </Item>
          <Menubar.Separator className="menu-separator" />
          <Menubar.Label className="menu-label">Appearance</Menubar.Label>
          <Menubar.RadioGroup value={appearance} onValueChange={(value) => setThemePreference(value as ThemePreference)}>
            {APPEARANCE.map(({ value, label }) => (
              <Menubar.RadioItem key={value} value={value} className="menu-item">
                <span className="grid size-4 place-items-center">
                  <Menubar.ItemIndicator>
                    <Check className="size-4" />
                  </Menubar.ItemIndicator>
                </span>
                {label}
              </Menubar.RadioItem>
            ))}
          </Menubar.RadioGroup>
        </Menu>

        <Menu label="Help" trigger="Help">
          <Item onSelect={() => open("help")}>Ask Tot</Item>
          <Item onSelect={() => open("features")}>What's inside</Item>
          <Item onSelect={() => open("roadmap")}>Roadmap</Item>
          <Item onSelect={() => open("rules")}>House rules</Item>
        </Menu>
      </Menubar.Root>

      <div className="ml-auto flex items-center gap-1.5">
        <button
          type="button"
          onClick={search}
          aria-label="Search Tot's computer"
          className="flex h-6 items-center gap-1.5 rounded-full border border-edge bg-fill-subtle pr-2 pl-2 text-xs text-fg-muted transition-colors hover:border-edge-strong hover:text-fg"
        >
          <Search className="size-3.5" />
          <span className="hidden lg:inline">Search</span>
          <span className="text-2xs text-fg-subtle tabular-nums">{MOD}K</span>
        </button>
        <button
          type="button"
          onClick={() => open("brains")}
          aria-label="Open Brains: Claude and ChatGPT usage"
          className="hidden items-center gap-2 rounded-md px-2 py-0.5 text-fg-muted transition-colors hover:bg-hover hover:text-fg md:flex"
        >
          <Meter mark={<ClaudeMark className="size-3.5" />} used={92} />
          <Meter mark={<OpenAIMark className="size-3.5 text-fg" />} used={34} />
        </button>
        <ThemeToggle className="size-6" />
        <span className="px-1 text-fg tabular-nums">
          {now.toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}
        </span>
        <button
          type="button"
          onClick={() => open("terminal")}
          className="h-6 rounded-full bg-fg px-3 text-xs font-medium text-canvas transition-colors hover:bg-fg/90"
        >
          Get TOT
        </button>
      </div>
    </header>
  );
}

function Menu({ label, trigger, children }: { label: string; trigger: ReactNode; children: ReactNode }) {
  return (
    <Menubar.Menu>
      <Menubar.Trigger
        aria-label={typeof trigger === "string" ? undefined : label}
        className="flex h-6 items-center gap-1.5 rounded-md px-2 text-fg-muted transition-colors hover:bg-hover hover:text-fg data-[highlighted]:bg-hover data-[state=open]:bg-selected data-[state=open]:text-fg"
      >
        {trigger}
      </Menubar.Trigger>
      <Menubar.Portal>
        {/* No exit animation: a closing menu that lingers would dismiss the next one when focus moves into it. */}
        <Menubar.Content className="menu z-[10020] w-56 data-[state=closed]:animate-none" align="start" sideOffset={5}>
          {children}
        </Menubar.Content>
      </Menubar.Portal>
    </Menubar.Menu>
  );
}

function Item({
  children,
  icon,
  shortcut,
  disabled,
  onSelect,
}: {
  children: ReactNode;
  icon?: ReactNode;
  shortcut?: string;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <Menubar.Item disabled={disabled} onSelect={onSelect} className="menu-item">
      {icon && <span className="grid size-4.5 shrink-0 place-items-center">{icon}</span>}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut && <span className="text-xs text-fg-subtle tabular-nums">{shortcut}</span>}
    </Menubar.Item>
  );
}

/** A provider's mark and how much of this week's usage is gone. */
function Meter({ mark, used }: { mark: ReactNode; used: number }) {
  return (
    <span className="flex items-center gap-1.5">
      {mark}
      <span className="h-1.5 w-7 overflow-hidden rounded-full bg-fill-strong">
        <span className={clsx("block h-full rounded-full", used > 80 ? "bg-amber-400" : "bg-emerald-400")} style={{ width: `${used}%` }} />
      </span>
    </span>
  );
}
