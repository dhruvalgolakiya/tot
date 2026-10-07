import { HeroArt } from "../../src/components/home/HeroArt";
import { ClaudeMark, OpenAIMark } from "../os/BrandMarks";
import { pillClass, ThemeToggle } from "../ui";
import { DemoComposer } from "./DemoComposer";
import { DemoGrid } from "./DemoGrid";

const INSTALL = "/docs/install";

/**
 * The landing page: TOT's Home as the app shows it. A pixel-art scene, the question and a composer that types
 * by itself, then Home's cards filled in by the crew. The earlier landing page (Tot's own device) is at /?os.
 */
export function HomePage() {
  return (
    <div className="min-h-dvh bg-canvas text-fg">
      <TopBar />
      <main>
        <section className="relative flex min-h-[86svh] flex-col items-center justify-end px-4 pt-32 pb-12 sm:pb-16">
          <HeroArt />
          <div className="hero-copy relative flex w-full max-w-2xl flex-col items-center text-center">
            <p className="inline-flex items-center gap-2 rounded-full border border-edge bg-canvas/60 px-3 py-1 text-xs text-fg-muted backdrop-blur-sm">
              <ClaudeMark className="size-3.5" />
              <OpenAIMark className="size-3.5" />
              Runs on your Claude and ChatGPT plans
            </p>
            <h1 className="mt-5 font-display text-4xl font-semibold tracking-tight text-balance text-fg-strong sm:text-5xl">
              What should your agents work on?
            </h1>
            <p className="mt-4 max-w-xl text-base text-pretty text-fg-muted sm:text-lg">
              TOT is your tiny AI team. Each agent gets its own computer, a memory that sticks and a face you'll get attached to. No API keys.
            </p>
            <DemoComposer className="mt-8 w-full" />
          </div>
        </section>

        <section aria-label="What TOT looks like at work" className="mx-auto w-full max-w-4xl px-4 pb-24">
          <DemoGrid />
        </section>

        <section className="border-t border-hairline px-4 py-20 text-center">
          <h2 className="font-display text-2xl font-semibold tracking-tight text-fg-strong sm:text-3xl">Your team is one install away</h2>
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
