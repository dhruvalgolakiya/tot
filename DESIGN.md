# TOT design standard

Calm, consistent, crisp — Linear / Vercel / ChatGPT-desktop craft on Grok's minimal dark look, with the
mascots as the only playful element. Dark-first; light mode must look equally deliberate.

Tokens live in `src/index.css`; primitives in `src/components/ui/`. **New and migrated code uses semantic
tokens only** — no `white/[0.0x]`, no `text-zinc-*`, no `text-[13px]`. (Exceptions: mascot art, code-block
chrome, and the `.dark` islands' internals.)

## 0. Style: ChatGPT/Codex

TOT's look now tracks ChatGPT's and Codex's desktop apps: true neutral greys (no blue/purple tint) —
dark canvas `#212121`, panel `#181818`, elevated `#2b2b2b`, bubble `#303030`; light canvas `#fff`, panel
`#f9f9f9`, bubble `#f4f4f4` — with the chat column full-bleed against the canvas instead of boxed in a
card. The composer and the wiki's "Ask about this page" box are pill-shaped (`rounded-full`/`.surface-raised`),
and tool/thinking lines in chat read as quiet, muted text rather than bordered chips. Settings read as flat
rows (label left, control right, `border-t border-hairline` between them) rather than boxed cards —
`cardClass()`'s default dropped its fill, keeping only a hairline border, so the few remaining "boxed" uses
(provider status, catalog cards) read as deliberate, not default. Buttons are pills (`rounded-full`); primary
is monochrome — `bg-fg text-canvas` (white-on-dark in dark mode, black-on-white in light), never the agent
accent. Switches, radio cards, segmented controls and tabs went neutral too (`bg-fg`/`bg-selected`, not
`bg-accent`) — the agent accent is reserved for genuinely tiny indicators (a search-match highlight, a badge
dot), not for fills, borders or "selected" states. Dialogs stay `rounded-2xl` with roomier `p-6` padding and
an 18px (`text-lg font-semibold`) title.

## 1. Theming in one paragraph

Light mode mirrors the palette (`white` becomes near-black, `zinc-100` ↔ `zinc-900`, …), so dark-first
classes keep their meaning in both themes. Semantic tokens add per-theme tuning on top (light hovers are
lighter, light focus rings darker). `class="dark"` on an element makes an always-dark island (tooltips,
code blocks). For a literal white or black that must not flip, use `fixed-white` / `fixed-black`.

## 2. Color tokens

| Role | Utility | Use for | Replaces |
|---|---|---|---|
| Text, strongest | `text-fg-strong` | page/dialog titles, wiki/hero headings | `zinc-50`, `white/92` on titles |
| Text, primary | `text-fg` | body, labels, row text when selected | `zinc-100`, `zinc-200`, `white/85–92` |
| Text, secondary | `text-fg-muted` | secondary text, idle nav rows, idle icons | `zinc-300`, `zinc-400`, `white/55–70` |
| Text, tertiary | `text-fg-subtle` | meta, hints, timestamps, captions, placeholders | `zinc-500`, `white/35–50` |
| Text, faint | `text-fg-faint` | disabled, decorative footers — never essential text | `zinc-600` |
| Hover overlay | `bg-hover` | hover on rows, ghost/icon buttons, menu items | `hover:bg-white/[0.03–0.08]` |
| Selected overlay | `bg-selected` | current row, pressed (`active:`), open trigger | `bg-white/[0.07–0.08]` on active rows |
| Fills | `bg-fill-subtle` · `bg-fill` · `bg-fill-strong` | cards/inputs · chips, tiles, skeletons · disabled send, strong chips | `bg-white/[0.02–0.03]` · `[0.04–0.06]` · `[0.08–0.1]` |
| Lines | `border-hairline` · `border-edge` · `border-edge-strong` | dividers, cards, panels · inputs, secondary buttons, menus · hovered controls | `border-white/[0.04–0.08]` · `/10` · `/15–25` |
| Accent | `bg-accent` · `text-accent-text` · `bg-accent-soft` (`hover:bg-accent-soft-hover`) · `border-accent-edge` | tiny indicators only: the agent-working dot, focus ring, links, search-match highlights | `[var(--agent-accent…)]` arbitrary values |
| Focus | `outline-focus` / `ring-focus` | only if you must draw focus yourself | `ring-[var(--agent-accent-ring)]` |
| Status | `text-success\|warning\|danger`, `bg-*-soft`, `border-*-edge`, `bg-danger-solid` | status text/icons, tinted boxes, destructive button | `emerald-*`, `amber-*`, `red-*` |

**Never** give a card, row or callout a colored bar down one side (`border-l-4`, a tinted left edge). Cards get an even hairline border all round, or none; status goes in a dot or badge.

Surfaces (unchanged): `bg-panel` app chrome (rail, sidebar) · `bg-canvas` main card and docked panels ·
`bg-elevated` menus, dialogs, selects, toasts · `bg-bubble` user messages · `bg-sunken` insets (screens,
paths) · `bg-scrim/60` overlays.

**Accent** is the active agent's mascot color and the only saturated color — but it's reserved for genuinely
tiny indicators now (the agent-working dot, focus, links, a search-match highlight), not for fills, borders
or "selected" states. Switches, radio cards, segmented controls and tabs went neutral (`bg-fg`/`bg-selected`).
Primary buttons are monochrome (`bg-fg text-canvas`), never accent. Status colors only carry status — never
decoration.

## 3. Typography

Inter (variable weight and optical size, Google Fonts, `display=swap`) for the UI and headings (`font-display` is Inter too, for display headings); Geist Mono for code.
Weights: 400 text, 500 labels/buttons/row emphasis, 600 headings. Never 700 in UI chrome.
Use `tabular-nums` for counts, sizes, times and countdowns.

| Token | Size / line | Use |
|---|---|---|
| `text-display` | 32/40, −0.025em, 600 | agent-home greeting, wiki page title (`text-2xl` on phones is fine) |
| `text-title` | 20/28, −0.015em, 600 | page titles (`PageHeader`), large empty states |
| `text-heading` | 15/22, −0.01em, 600 | dialog & side-panel titles, sidebar agent name |
| `text-chat` | 16/26 | user bubble, composer, chat status line (assistant prose = `.markdown`, 16/28) |
| `text-sm` | 14/20 | default UI: forms, settings, dialogs, menus, md buttons, card titles |
| `text-ui` | 13/18 | dense rows: chat list, settings nav, wiki tree, tool rows, sm buttons, callouts |
| `text-xs` | 12/16 | hints, meta, timestamps, descriptions under 14px titles, tooltips |
| `text-2xs` | 11/16 | badges, kbd, counters only |
| mono | 13/1.6 code blocks; `text-xs` tool output; `text-ui` inline paths/ids | |

Use `leading-relaxed` only for multi-line descriptions/hints. One title + at most two text sizes per component.

## 4. Space, size, shape

- **4px grid.** Use Tailwind steps 0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12. No arbitrary px.
- **Gutters:** page content `px-6 py-8` (phones `px-4`); dialogs `px-5`; side panels `p-4`; cards `p-4` (`p-3` dense).
- **Rhythm:** sections `space-y-8` (or a `border-t border-hairline pt-6` divider) · items in a section `space-y-4` ·
  label → control `space-y-1.5` · related controls `gap-2` · stacked cards `space-y-2`.
- **Widths:** chat column `max-w-3xl`; settings column `max-w-[640px]`; dialogs `max-w-sm` (confirm) / `max-w-md` / `max-w-lg`.
- **Heights:** 28 `h-7` (sm icon buttons, pills, chips) · 32 `h-8` (sm buttons, `.input-sm`, menu items, tree rows) ·
  36 `h-9` (md buttons, `.input`, md icon buttons, nav rows) · 56 `h-14` (top bars, panel headers).
- **Radii:** `rounded-md` 6 (kbd, sm icon buttons) · `rounded-lg` 8 (inputs, rows, menu items, callouts, main card) ·
  `rounded-xl` 12 (cards, menus, tool cards, toasts, `.input`/`.input-sm` in settings and dialogs) ·
  `rounded-2xl` 16 (dialogs; the apps catalog grid) · `rounded-full` (buttons, badges, pills, avatars, switches,
  send/stop) · `rounded-3xl` only for the composer and user bubble. Nested radius = outer − inset (menu 12 − p-1 → item 8).
- **Icons:** lucide, `size-3.5` (14: sm buttons, chips, meta rows) · `size-4` (16: default, menus, rows) ·
  `size-4.5` (18: md icon buttons, bars). Stroke is 1.75 app-wide (`LucideProvider` in `main.tsx`); pass
  `strokeWidth` only for the send/ask arrow (2.25). Icons are `text-fg-muted`/`text-fg-subtle` or inherit;
  colored only for status or accent.

## 5. Surfaces & elevation

In-flow things never cast shadows: cards are flat — `border-hairline`, no fill by default (use `Card`/`cardClass`;
pass `bg-fill-subtle` yourself for the rare card that wants one, e.g. the apps catalog grid).
Shadows exist only for things floating above the page:
`shadow-popover` (menus, tooltips, toasts, dropdowns) · `shadow-dialog` (modals, overlay drawers/panels) ·
`.surface-raised` (composer, wiki ask box; add `.accent-focus` for the focus glow). Don't use `shadow-lg/xl/2xl`.

## 6. States

| State | Recipe |
|---|---|
| Hover | `hover:bg-hover` and text one tier up (`text-fg-muted hover:text-fg`). Bordered: `hover:border-edge-strong`. |
| Pressed | `active:bg-selected` |
| Selected / current | `bg-selected text-fg` + `aria-current="page"` (nav) |
| Menu open | trigger gets `data-[state=open]:bg-selected` (built into `IconButton`) |
| On / checked | strong: `bg-accent` (switch, radio dot); soft: `bg-accent-soft text-accent-text` (toggle buttons, segmented) |
| Disabled | `disabled:opacity-50 disabled:pointer-events-none` (built into primitives); no hover |
| Focus | Global: 2px `--focus-ring` outline, offset 2px. Never `outline-none` without a replacement. In clipped lists: `focus-visible:-outline-offset-2`. Inputs: accent border + 3px glow (built into `.input`). |
| Invalid | `aria-invalid="true"` on the control + `Field error=…` |
| Hover-revealed | `opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100` — all four, always |

## 7. Motion

Hover: `transition-colors` (150ms). Reveal: `transition-opacity`. Enter: `animate-pop-in` (menus, dialogs),
`animate-fade-in` (overlays, tooltips), `animate-slide-in-right` (panels); exit `animate-pop-out` / `animate-fade-out`
(120ms). Toggles/thumbs: `duration-200 ease-emphasized`. Nothing over 240ms. No movement on hover (no
`hover:-translate-y-*`, no scale). Busy: `LoaderCircle animate-spin` in `text-fg-subtle` (or `text-accent` for agent work).
Reduced motion is handled globally.

## 8. Primitives (`src/components/ui`)

| Primitive | API | Notes |
|---|---|---|
| `Button`, `buttonClass()` | `variant` primary · secondary · ghost · danger · ghost-danger; `size` sm (32) · md (36) | `buttonClass` styles `<a>` as a button |
| `IconButton` | `label` (required), `size` sm (28/14) · md (36/18) | wrap in `<Tip content>`; shows pressed/open states |
| `Modal`, `ModalBody`, `ModalFooter` | `title`, `description`, `className` (width); footer `divider` | footer: ghost/secondary first, primary last |
| `SidePanel` | `label`, `icon`, `title`, `onClose`, `width` | docked card ≥ wide, drawer below |
| `Field` | `label`, `htmlFor`, `hint`, `error` | control is `.input` / `.input-sm` / `SearchInput` / `SecretInput` / `select.input` |
| `SearchInput` | input props + `compact`, `trailing`, `containerClassName` | icon included; behavior stays with the caller |
| `Switch`, `RadioCards`, `SecretInput` | unchanged APIs | |
| `Card`, `cardClass()` | `padding` none · sm · md, `interactive` | sections: `border-t border-hairline` |
| `PageHeader`, `SectionHeader` | `title`, `description`, `action`; section `as` h2/h3 | |
| `ListRow`, `listRowClass()` | `selected`, `size` sm (32) · md (36), `icon`, `trailing` | class helper for rows with custom children |
| `Badge` | `tone` neutral · accent · success · warning · danger, `dot` | 20px, `text-2xs` |
| `Callout` | `tone` info · success · warning · danger, `action` | inline errors/notes; danger = `role="alert"` |
| `EmptyState` | `icon` or `media`, `title`, `description`, `action`, `variant` plain · dashed, `size` sm · md | |
| `Skeleton` | `className` (shape) | wrap groups in `aria-busy` + `aria-label` |
| `Tip`, `Kbd`, `StatusDot`, `TickText` | unchanged | tooltips are always dark |

CSS classes: `.menu` · `.menu-item` · `.menu-item-danger` · `.menu-label` · `.menu-separator` · `.input` ·
`.input-sm` · `.link` (accent, in copy) · `.link-muted` (quiet text actions) · `.group-label` (list group titles,
sentence case — replaces `.label-caps`) · `.surface-raised` · `.accent-focus`.

## 9. Patterns

- **Page:** `PageHeader` (mb-8) → sections separated by `space-y-8`. One page-level primary action at most.
- **Section:** `SectionHeader` → content `mt-3`. Titles in sentence case, no trailing colon or period.
- **Setting row:** `flex items-start justify-between gap-4 py-3`; left: title `text-sm font-medium text-fg` +
  description `mt-0.5 text-xs leading-relaxed text-fg-subtle`; right: the control (`pt-0.5`). Several rows in a
  group: `Card padding="none"` with `divide-y divide-hairline` and `px-4` rows. One row on its own (e.g. with a
  single quiet link under it): skip the card, just a `border-t border-hairline pt-5` divider above it.
- **Card list:** `ul.space-y-2 > li.cardClass({ padding: "sm" })`: title `text-sm font-medium text-fg`, meta
  `text-xs text-fg-subtle`, at most one visible trailing control (a Switch or a button) plus an Ellipsis menu for the rest.
- **List row:** `ListRow` / `listRowClass`; trailing meta in `text-xs text-fg-subtle tabular-nums`; row actions
  hover-revealed (`IconButton size="sm"`).
- **Expandable row** (a project in the sidebar): the row itself navigates; its leading icon turns into a chevron on
  hover (always, on touch screens) that shows or hides the nested rows, which sit `pl-6` in. No separate toggle column.
- **Menu:** trigger is an `IconButton` (Ellipsis) or a ghost button with `ChevronDown`;
  `DropdownMenu.Content className="menu w-48" sideOffset={4}`; icons `size-4 text-fg-muted`; destructive item last,
  after a separator, with `.menu-item-danger`.
- **Dialog:** `Modal` + `ModalBody` (`space-y-4`) + `ModalFooter`. Confirm dialogs: `max-w-sm`, title is a question
  ("Delete chat?"), description names the object and the consequence, footer `divider={false}`: Cancel (ghost) +
  confirm (`danger` or `primary`) with the verb ("Delete", not "OK").
- **Side panel:** `SidePanel`; body `min-h-0 flex-1 overflow-y-auto p-4 space-y-6`; tabs are underline tabs
  (`h-10 text-sm text-fg-muted data-[state=active]:text-fg` + 2px `border-accent` underline).
- **Empty state:** `EmptyState` — say what will appear here and how to make it appear; one action. Lists inside a
  page use `variant="dashed"`; sidebars/panels `size="sm"`; search misses: "No chats match “x”".
- **Loading:** `Skeleton` shaped like the content (rows → lines, cards → `h-16 rounded-xl`). No bare "Loading…" for
  regions; buttons switch label to the -ing verb ("Saving…") and disable.
- **Inline error:** `Callout tone="danger"` where the failure happened, plus `action={<button className="link-muted">Try again</button>}`.
  Field-level: `Field error` + `aria-invalid`. Copy: what failed + what to do ("Couldn't load your chats.").
- **Toasts (sonner):** only for results not visible on screen. Sentence case, ≤ 6 words, no trailing period for
  success ("Saved", "Copied", "Routine is running"); errors say what failed and the fix in one sentence.
- **Buttons:** one primary per area (page, card, dialog, composer). Start destructive actions with `ghost-danger`
  (or a menu item), confirm with `danger`. Icon + label for primary actions only when the icon adds meaning.
- **Few visible actions:** ≤ 2 side-by-side controls in a row or card; the rest go in one Ellipsis menu or appear on hover.

## 10. Do / don't

- **Do** use `text-fg*`, `bg-hover/selected/fill*`, `border-hairline/edge` — **don't** use `white/[0.0x]` or `zinc-*`.
- **Do** use `text-ui`/`text-xs`/`text-2xs` — **don't** write `text-[13px]`, `text-[11px]`, `text-[15px]`.
- **Do** keep icons 14/16/18 and inherit color — **don't** mix icon sizes within one row or tint icons for decoration.
- **Do** rely on the global focus outline — **don't** add `outline-none` (or `focus-visible:ring-*`) to buttons/links.
- **Do** keep cards flat (hairline + fill) — **don't** add shadows, gradients or double borders to in-flow content.
- **Do** use `Badge`/`Callout`/`EmptyState`/`Skeleton` — **don't** hand-roll `rounded-md bg-white/[0.06] px-1.5 text-[11px]`.
- **Do** check every change in light mode: borders visible, text ≥ 4.5:1 (`fg-subtle` is the floor), accent readable.
- **Don't** use accent for primary buttons, headings or large fills; **don't** use status colors decoratively.
- **Don't** animate layout or move things on hover; **don't** exceed 240ms.
- **Don't** change behavior, routes, API calls, copy meaning, or `aria-*` semantics while restyling.
