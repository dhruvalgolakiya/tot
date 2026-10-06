import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { Dialog } from "radix-ui";
import { ArrowLeft, ArrowRight, Menu, Search as SearchIcon, X } from "lucide-react";
import { Mascot } from "../../src/components/mascot";
import { Logo } from "../../src/components/ui/Logo";
import { isMac } from "../../src/lib/format";
import { crew } from "../crew";
import { ThemeToggle } from "../ui";
import { sourceFor } from "./content";
import { headingsOf, smarten, type Heading } from "./headings";
import { GROUPS, PAGES, pageFor, type DocPage } from "./manifest";
import { Markdown } from "./Markdown";
import { hrefFor, onDocsLinkClick, useSlug } from "./router";
import { Search } from "./Search";
import { StatusChip, StatusMark } from "./StatusChip";

const MOD = isMac ? "⌘" : "Ctrl ";

/** TOT's docs: a slim nav on the left, one narrow reading column, and an on-this-page list on wide screens. */
export function DocsApp() {
  const slug = useSlug();
  const page = pageFor(slug);
  const [searching, setSearching] = useState(false);
  const [menu, setMenu] = useState(false);

  useEffect(() => {
    document.title = !page ? "Not found · TOT docs" : page.slug ? `${smarten(page.title)} · TOT docs` : "TOT docs";
  }, [page]);

  // ⌘K (or Ctrl+K) and "/" open search.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearching((current) => !current);
        return;
      }
      const typing = (event.target as HTMLElement).closest?.("input, textarea, [contenteditable='true']");
      if (event.key === "/" && !event.metaKey && !event.ctrlKey && !typing) {
        event.preventDefault();
        setSearching(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // A deep link to a heading (/docs/memory#dreaming) lands on it.
  useEffect(() => {
    if (!location.hash) return;
    const target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
    target?.scrollIntoView({ block: "start" });
  }, []);

  const headings = useMemo(() => {
    if (!page) return [];
    const found = headingsOf(sourceFor(page));
    // The docs home ends with the page list, which isn't part of its markdown.
    return page.slug === "" ? [...found, { depth: 2 as const, text: "Find your way", id: "find-your-way", line: 0 }] : found;
  }, [page]);

  return (
    <div className="min-h-dvh bg-canvas">
      <TopBar onMenu={() => setMenu(true)} onSearch={() => setSearching(true)} />
      <div className="mx-auto flex w-full max-w-[88rem]">
        <aside className="sticky top-14 hidden h-[calc(100dvh-3.5rem)] w-64 shrink-0 overflow-y-auto px-4 pt-10 pb-8 lg:block">
          <Nav current={slug} />
        </aside>
        <main className="min-w-0 flex-1 px-5 pt-9 pb-16 sm:px-8 lg:px-12 lg:pt-14">
          {page ? <PageView key={page.slug} page={page} /> : <NotFound />}
        </main>
        <aside className="sticky top-14 hidden h-[calc(100dvh-3.5rem)] w-60 shrink-0 overflow-y-auto pt-14 pr-6 pb-8 xl:block">
          {headings.length > 1 && <OnThisPage key={slug} headings={headings} />}
        </aside>
      </div>
      <MobileNav open={menu} onOpenChange={setMenu} current={slug} />
      <Search open={searching} onOpenChange={setSearching} />
    </div>
  );
}

function TopBar({ onMenu, onSearch }: { onMenu: () => void; onSearch: () => void }) {
  return (
    <header className="sticky top-0 z-40 border-b border-hairline bg-canvas/90 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-[88rem] items-center gap-1 px-3 sm:px-5">
        <button
          type="button"
          onClick={onMenu}
          aria-label="Open the docs menu"
          className="grid size-9 place-items-center rounded-lg text-fg-muted transition-colors hover:bg-hover hover:text-fg lg:hidden"
        >
          <Menu className="size-4.5" />
        </button>
        <Brand />
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={onSearch}
            className="hidden h-8 w-60 items-center gap-2 rounded-full border border-edge bg-fill-subtle pr-1.5 pl-3 text-sm text-fg-subtle transition-colors hover:border-edge-strong hover:text-fg-muted sm:flex"
          >
            <SearchIcon className="size-4" />
            Search the docs
            <kbd className="ml-auto rounded-full border border-hairline px-1.5 text-2xs font-medium text-fg-subtle tabular-nums">{MOD}K</kbd>
          </button>
          <button
            type="button"
            onClick={onSearch}
            aria-label="Search the docs"
            className="grid size-9 place-items-center rounded-lg text-fg-muted transition-colors hover:bg-hover hover:text-fg sm:hidden"
          >
            <SearchIcon className="size-4.5" />
          </button>
          <ThemeToggle className="size-9" />
        </div>
      </div>
    </header>
  );
}

/** The rings and the name (back to the landing page), then "Docs" (the docs home). */
function Brand() {
  return (
    <div className="flex items-center gap-1">
      <a href="/" aria-label="TOT home" className="flex items-center gap-2 rounded-lg px-1.5 py-1">
        <Logo className="w-6" />
        <span className="font-display text-[17px] font-semibold tracking-tight text-fg-strong">TOT</span>
      </a>
      <span aria-hidden="true" className="text-fg-faint">
        /
      </span>
      <a
        href={hrefFor("")}
        onClick={(event) => onDocsLinkClick(event, hrefFor(""))}
        className="rounded-md px-1.5 py-1 text-[15px] font-medium text-fg-muted transition-colors hover:text-fg"
      >
        Docs
      </a>
    </div>
  );
}

function Nav({ current, onNavigate, touch = false }: { current: string; onNavigate?: () => void; touch?: boolean }) {
  return (
    <nav aria-label="Docs" className="space-y-7">
      {GROUPS.map((group) => (
        <div key={group}>
          <p className="px-2.5 pb-1.5 text-[13px] font-medium text-fg-subtle">{group}</p>
          <ul className="space-y-px">
            {PAGES.filter((page) => page.group === group).map((page) => {
              const active = page.slug === current;
              const href = hrefFor(page.slug);
              return (
                <li key={page.slug}>
                  <a
                    href={href}
                    aria-current={active ? "page" : undefined}
                    onClick={(event) => onDocsLinkClick(event, href, onNavigate)}
                    className={clsx(
                      "flex items-center rounded-lg px-2.5 transition-colors",
                      touch ? "min-h-10 text-[15px]" : "min-h-9 py-1 text-sm",
                      active ? "bg-selected font-medium text-fg" : "text-fg-muted hover:bg-hover hover:text-fg",
                    )}
                  >
                    {smarten(page.nav ?? page.title)}
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** Phones and narrow windows: the nav in a drawer from the left. */
function MobileNav({ open, onOpenChange, current }: { open: boolean; onOpenChange: (open: boolean) => void; current: string }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-scrim/40 data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in lg:hidden" />
        <Dialog.Content
          aria-describedby={undefined}
          className="docs-drawer fixed inset-y-0 left-0 z-50 flex w-[86vw] max-w-80 flex-col border-r border-hairline bg-canvas shadow-dialog lg:hidden"
        >
          <Dialog.Title className="sr-only">Docs menu</Dialog.Title>
          <div className="flex h-14 shrink-0 items-center gap-1 border-b border-hairline px-3">
            <Brand />
            <Dialog.Close
              aria-label="Close the menu"
              className="ml-auto grid size-9 place-items-center rounded-lg text-fg-muted transition-colors hover:bg-hover hover:text-fg"
            >
              <X className="size-4.5" />
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-6 pb-10">
            <Nav current={current} onNavigate={() => onOpenChange(false)} touch />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function PageView({ page }: { page: DocPage }) {
  return (
    <article className="mx-auto max-w-[40rem]">
      <PageHeader page={page} />
      <div className="mt-10">
        <Markdown source={sourceFor(page)} />
      </div>
      {page.slug === "" && <FindYourWay />}
      <Pager page={page} />
      <footer className="mt-12 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 border-t border-hairline pt-6 text-xs text-fg-subtle">
        <p>TOT is in private preview. These docs describe what’s built today.</p>
        <a href="/" className="link-muted">
          Back to the TOT site
        </a>
      </footer>
    </article>
  );
}

function PageHeader({ page }: { page: DocPage }) {
  const home = page.slug === "";
  return (
    <header>
      {home ? (
        <div aria-hidden="true" className="flex items-end gap-1.5">
          <Mascot spec={crew.tot.spec} state="speaking" size={60} />
          <Mascot spec={crew.mochi.spec} state="idle" size={44} />
          <Mascot spec={crew.bolt.spec} state="working" size={44} />
          <Mascot spec={crew.nimbus.spec} state="sleeping" size={40} />
        </div>
      ) : (
        <Mascot spec={crew[page.mascot].spec} state={page.mood ?? "idle"} size={52} className="-ml-1" />
      )}
      <p className="group-label mt-5 flex items-center gap-2">
        {home ? "TOT docs" : page.group}
        {page.status && (
          <>
            <span aria-hidden="true" className="text-fg-subtle/60">
              ·
            </span>
            <StatusMark status={page.status} />
          </>
        )}
      </p>
      <h1 className="mt-1.5 font-display text-[2.375rem] leading-[1.1] font-semibold tracking-tight text-balance text-fg-strong sm:text-[2.75rem]">
        {smarten(page.title)}
      </h1>
      <p className="mt-3 text-lg leading-relaxed text-pretty text-fg-muted">{smarten(page.description)}</p>
      {page.status && page.status !== "available" && page.missing && (
        <p className="mt-4 text-sm text-fg-subtle">
          {smarten(page.missing)}{" "}
          <a href={hrefFor("not-yet")} onClick={(event) => onDocsLinkClick(event, hrefFor("not-yet"))} className="link-muted whitespace-nowrap">
            What’s not built yet
          </a>
        </p>
      )}
    </header>
  );
}

/** The docs home lists every page, by group, with its status. */
function FindYourWay() {
  return (
    <section className="mt-14">
      <h2 id="find-your-way" className="mb-6 scroll-mt-24 font-display text-2xl font-semibold tracking-tight text-fg-strong">
        Find your way
      </h2>
      <div className="space-y-8">
        {GROUPS.map((group) => (
          <div key={group}>
            <p className="group-label mb-2.5">{group}</p>
            <ul className="grid gap-2 sm:grid-cols-2">
              {PAGES.filter((page) => page.group === group && page.slug !== "").map((page) => {
                const href = hrefFor(page.slug);
                return (
                  <li key={page.slug}>
                    <a
                      href={href}
                      onClick={(event) => onDocsLinkClick(event, href)}
                      className="flex h-full gap-3 rounded-xl border border-hairline p-3.5 transition-colors hover:border-edge hover:bg-hover"
                    >
                      <span aria-hidden="true" className="shrink-0 pt-0.5">
                        <Mascot spec={crew[page.mascot].spec} state={page.mood ?? "idle"} size={30} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-start justify-between gap-2">
                          <span className="text-sm font-medium text-fg">{smarten(page.nav ?? page.title)}</span>
                          {page.status && page.status !== "available" && <StatusChip status={page.status} size="sm" />}
                        </span>
                        <span className="mt-0.5 line-clamp-2 block text-xs leading-relaxed text-fg-subtle">{smarten(page.description)}</span>
                      </span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}

function Pager({ page }: { page: DocPage }) {
  const index = PAGES.indexOf(page);
  const previous = PAGES[index - 1];
  const next = PAGES[index + 1];
  const card = (target: DocPage, direction: "previous" | "next") => {
    const href = hrefFor(target.slug);
    return (
      <a
        href={href}
        onClick={(event) => onDocsLinkClick(event, href)}
        className={clsx(
          "flex flex-col gap-0.5 rounded-xl border border-hairline px-4 py-3 transition-colors hover:border-edge hover:bg-hover",
          direction === "next" && "items-end text-right sm:col-start-2",
        )}
      >
        <span className="flex items-center gap-1 text-xs text-fg-subtle">
          {direction === "previous" && <ArrowLeft className="size-3.5" />}
          {direction === "previous" ? "Previous" : "Next"}
          {direction === "next" && <ArrowRight className="size-3.5" />}
        </span>
        <span className="text-sm font-medium text-fg">{smarten(target.nav ?? target.title)}</span>
      </a>
    );
  };
  return (
    <nav aria-label="More pages" className="mt-16 grid gap-2 sm:grid-cols-2">
      {previous && card(previous, "previous")}
      {next && card(next, "next")}
    </nav>
  );
}

/** The page's headings, with the one you're reading picked out. */
function OnThisPage({ headings }: { headings: Heading[] }) {
  const active = useActiveHeading(headings);
  return (
    <nav aria-label="On this page">
      <p className="pb-2 text-[13px] font-medium text-fg-subtle">On this page</p>
      <ul className="space-y-0.5">
        {headings.map((heading) => (
          <li key={heading.id}>
            <a
              href={`#${heading.id}`}
              onClick={(event) => onDocsLinkClick(event, `#${heading.id}`)}
              aria-current={heading.id === active ? "location" : undefined}
              className={clsx(
                "block py-1 text-[13.5px] leading-snug transition-colors",
                heading.depth === 3 && "pl-3",
                heading.id === active ? "text-fg" : "text-fg-subtle hover:text-fg-muted",
              )}
            >
              {heading.text}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

function useActiveHeading(headings: Heading[]): string | null {
  const [active, setActive] = useState<string | null>(null);
  useEffect(() => {
    const update = () => {
      let current: string | null = null;
      for (const heading of headings) {
        const element = document.getElementById(heading.id);
        if (element && element.getBoundingClientRect().top < 140) current = heading.id;
      }
      const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
      if (atBottom && window.scrollY > 0) current = headings.at(-1)?.id ?? current;
      setActive(current);
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [headings]);
  return active;
}

function NotFound() {
  return (
    <div className="mx-auto max-w-[40rem] pt-6">
      <Mascot spec={crew.boo.spec} state="error" size={56} />
      <h1 className="mt-5 font-display text-4xl font-semibold tracking-tight text-fg-strong">This page isn’t here</h1>
      <p className="mt-3 text-lg text-fg-muted">It may have moved, or the link has a typo.</p>
      <a
        href={hrefFor("")}
        onClick={(event) => onDocsLinkClick(event, hrefFor(""))}
        className="mt-6 inline-flex h-9 items-center rounded-full bg-fg px-4 text-sm font-medium text-canvas transition-colors hover:bg-fg/90"
      >
        Go to the docs home
      </a>
    </div>
  );
}
