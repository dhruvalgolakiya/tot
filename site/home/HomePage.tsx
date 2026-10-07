import { HeroArt } from "../../src/components/home/HeroArt";
import { ClaudeMark, OpenAIMark } from "../os/BrandMarks";
import { pillClass, ThemeToggle } from "../ui";
import { Crew } from "./Crew";
import { DemoChat } from "./DemoChat";
import { DemoLedger, Face, WORKING } from "./DemoLedger";

const INSTALL = "/docs/install";

/**
 * The landing page. A scene of floating islands with the pitch on its open sky, then "Tonight": a chat where work
 * is handed off beside Home's ledger, then the crew. The earlier landing page (Tot's own device) is at /?os.
 */
export function HomePage() {
  return (
    <div className="mascot-still min-h-dvh bg-canvas text-fg">
      <TopBar />
      <main>
        <Hero />
        <Tonight />

        <section aria-labelledby="crew-title" className="mx-auto w-full max-w-5xl px-4 pb-24 sm:px-6">
          <h2 id="crew-title" className="font-display text-2xl font-semibold tracking-tight text-fg-strong sm:text-3xl">
            Meet the crew
          </h2>
          <p className="mt-2 max-w-xl text-sm text-pretty text-fg-muted sm:text-base">
            Each agent works from its own island: a computer of its own, the brains you attach to it and a model to think with. Make as many as
            you like.
          </p>
          <div className="mt-6">
            <Crew />
          </div>
        </section>

        <section className="border-t border-hairline px-4 py-20 text-center">
          <h2 className="font-display text-2xl font-semibold tracking-tight text-fg-strong sm:text-3xl">Your crew is one install away</h2>
          <p className="mx-auto mt-3 max-w-md text-sm text-fg-muted">Log in to Claude or ChatGPT once, start TOT, and say hi to Tot.</p>
          <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
            <a href={INSTALL} className={pillClass("primary")}>
              Get TOT
            </a>
            <a href="/docs" className={pillClass()}>
              Read the docs
            </a>
          </div>
        </section>
      </main>
      <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-hairline px-6 py-6 text-xs text-fg-subtle">
        <span className="flex items-center gap-2">
          <img src="/tot.svg" alt="" className="size-4 rounded" />
          TOT · your tiny AI team
        </span>
        <nav aria-label="Footer" className="flex items-center gap-4">
          <a href="/docs" className="transition-colors hover:text-fg-muted">
            Docs
          </a>
          <a href={INSTALL} className="transition-colors hover:text-fg-muted">
            Install
          </a>
          <a href="/?os" className="transition-colors hover:text-fg-muted">
            Tot OS
          </a>
        </nav>
      </footer>
    </div>
  );
}

/**
 * The scene is a band across the top (21:9, or 3:2 on phones), never stretched to the hero's height. Wide screens
 * put the pitch on its open sky, to the right of the islands; narrower ones put it under them.
 */
function Hero() {
  return (
    <section className="relative flex flex-col px-4 pt-[56vw] pb-14 sm:px-6 md:pt-[34vw] lg:min-h-[calc(100vw*9/21)] lg:justify-center lg:pt-20 lg:pb-20">
      <HeroArt className="bottom-auto aspect-[3/2] md:aspect-[21/9]" />
      <div className="hero-scrim relative isolate mx-auto flex w-full max-w-xl flex-col items-center text-center lg:mr-[7vw] lg:ml-auto lg:max-w-[min(34rem,42vw)] lg:items-start lg:text-left">
        <h1 className="hero-copy font-display text-4xl font-semibold tracking-tight text-balance text-fg-strong sm:text-5xl xl:text-6xl">
          Hand it to the night shift.
        </h1>
        <p className="hero-copy mt-5 text-base text-pretty text-fg sm:text-lg">
          TOT is a tiny AI team that keeps working while you're away. Each agent gets its own computer, a memory that sticks and a face you'll get attached to.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-3 max-lg:justify-center">
          <a href={INSTALL} className={pillClass("primary")}>
            Get TOT
          </a>
          <a href="#tonight" className={pillClass()}>
            See it work
          </a>
        </div>
        <p className="hero-copy mt-6 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-fg-subtle max-lg:justify-center">
          Runs on the
          <ClaudeMark className="size-3.5" /> Claude and
          <OpenAIMark className="size-3.5" /> ChatGPT plans you already pay for. No API keys.
        </p>
      </div>
    </section>
  );
}

/** Handing work off in a chat, beside everything in flight: one panel, like the app. */
function Tonight() {
  return (
    <section id="tonight" aria-labelledby="tonight-title" className="mx-auto w-full max-w-5xl scroll-mt-6 px-4 pb-24 sm:px-6">
      <h2 id="tonight-title" className="font-display text-2xl font-semibold tracking-tight text-fg-strong sm:text-3xl">
        Hand it off in a sentence
      </h2>
      <p className="mt-2 max-w-xl text-sm text-pretty text-fg-muted sm:text-base">
        Ask in a chat. The agent picks it up on its own computer, and everything in flight lands in one list: what needs you first, then what's
        working, what's ready to land and what's coming up.
      </p>
      <div className="mt-8 overflow-hidden rounded-2xl border border-hairline bg-panel">
        <header className="flex h-12 items-center gap-3 border-b border-hairline px-4">
          <span className="text-sm font-medium text-fg">Tonight</span>
          <span className="truncate text-xs text-fg-subtle max-sm:hidden">3 working · 1 needs you · 2 ready to land</span>
          <span className="ml-auto flex items-center gap-1">
            {WORKING.map((task) => (
              <Face key={task.who} who={task.who} working size={22} />
            ))}
            <Face who="mochi" size={22} />
          </span>
        </header>
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]">
          <div className="border-hairline max-lg:border-b lg:border-r">
            <DemoChat />
          </div>
          <div className="p-2 sm:p-3">
            <DemoLedger />
          </div>
        </div>
      </div>
    </section>
  );
}

/** Over the scene: the name on the left; docs, the theme and the way in on the right. */
function TopBar() {
  return (
    <header className="absolute inset-x-0 top-0 z-10 flex h-16 items-center gap-2 px-4 sm:px-6">
      <a href="/" className="flex items-center gap-2 rounded-lg px-1 py-1 text-sm font-semibold text-fg-strong">
        <img src="/tot.svg" alt="" className="size-6 rounded-md" />
        TOT
      </a>
      <nav aria-label="Site" className="ml-auto flex items-center gap-1">
        <a href="/docs" className="hidden h-9 items-center rounded-full px-3 text-sm font-medium text-fg-muted transition-colors hover:text-fg sm:inline-flex">
          Docs
        </a>
        <a href="/?os" className="hidden h-9 items-center rounded-full px-3 text-sm font-medium text-fg-muted transition-colors hover:text-fg sm:inline-flex">
          Tot OS
        </a>
        <ThemeToggle className="size-9" />
        <a href={INSTALL} className={pillClass("primary")}>
          Get TOT
        </a>
      </nav>
    </header>
  );
}
