import { useEffect, useState } from "react";
import clsx from "clsx";
import type { MascotState } from "@shared/types";
import { Mascot } from "../src/components/mascot";
import { crew, type CrewMember } from "./crew";
import { Brains, Features } from "./Features";
import { Hero } from "./Hero";
import { MascotLab } from "./MascotLab";
import { Faq, QuickStart, Roadmap } from "./Roadmap";
import { Day, Never } from "./Story";
import { ctaClass, Reveal, ThemeToggle } from "./ui";

const LINKS = [
  { href: "#features", label: "Features" },
  { href: "#make-one", label: "Make one" },
  { href: "#safety", label: "Safety" },
  { href: "#roadmap", label: "Roadmap" },
  { href: "#faq", label: "FAQ" },
];

export function Landing() {
  return (
    <>
      <Nav />
      <main>
        <Hero />
        <Brains />
        <Features />
        <MascotLab />
        <Day />
        <Never />
        <Roadmap />
        <QuickStart />
        <Faq />
        <Closing />
      </main>
      <Footer />
    </>
  );
}

function Logo() {
  return (
    <a href="#" className="flex items-center gap-2.5 rounded-lg">
      <img src="/tot.svg" alt="" className="size-7 rounded-lg" />
      <span className="font-display text-lg font-semibold tracking-tight text-fg-strong">TOT</span>
    </a>
  );
}

function Nav() {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const update = () => setScrolled(window.scrollY > 8);
    update();
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, []);
  return (
    <nav
      className={clsx(
        "fixed inset-x-0 top-0 z-50 border-b transition-colors",
        scrolled ? "border-hairline bg-canvas/80 backdrop-blur-lg" : "border-transparent",
      )}
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-4 sm:px-6">
        <Logo />
        <div className="hidden flex-1 items-center justify-center gap-1 md:flex">
          {LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="rounded-full px-3 py-1.5 text-sm text-fg-muted transition-colors hover:bg-hover hover:text-fg"
            >
              {link.label}
            </a>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1 md:ml-0">
          <ThemeToggle />
          <a
            href="#start"
            className="inline-flex h-9 items-center rounded-full bg-fg px-4 text-sm font-medium text-canvas transition-colors hover:bg-fg/90"
          >
            Get started
          </a>
        </div>
      </div>
    </nav>
  );
}

/** The closing call to action: the whole cast drifting by. */
function Closing() {
  const cast = Object.keys(crew) as CrewMember[];
  const states: MascotState[] = ["idle", "speaking", "thinking", "working", "idle", "sleeping", "speaking", "idle", "thinking", "idle"];
  const row = cast.map((who, index) => ({ who, state: states[index % states.length]! }));
  return (
    <section className="overflow-hidden px-4 pt-12 pb-24 sm:px-6 sm:pb-32">
      <div aria-hidden="true" className="mask-x-from-80% mask-x-to-100% mb-10 overflow-hidden">
        <div className="parade flex w-max gap-10">
          {[...row, ...row].map(({ who, state }, index) => (
            <Mascot key={`${who}-${index}`} spec={crew[who].spec} state={state} size={72} />
          ))}
        </div>
      </div>
      <Reveal className="mx-auto max-w-3xl text-center">
        <h2 className="font-display text-4xl font-semibold tracking-tight text-balance text-fg-strong sm:text-6xl">
          Your team is ready.
          <span className="block text-fg-subtle">They already picked their hats.</span>
        </h2>
        <div className="mt-9 flex flex-col items-center justify-center gap-3 sm:flex-row">
          <a href="#start" className={ctaClass("primary")}>
            Run it on your Mac
          </a>
          <a href="#features" className={ctaClass("secondary")}>
            Take the tour again
          </a>
        </div>
      </Reveal>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-hairline px-4 py-10 sm:px-6">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 sm:flex-row sm:items-center">
        <div className="flex items-center gap-4">
          <Logo />
          <p className="text-ui text-fg-subtle">Made with an unreasonable number of mascots.</p>
        </div>
        <div className="flex flex-wrap items-center gap-1 sm:ml-auto">
          {LINKS.map((link) => (
            <a key={link.href} href={link.href} className="link-muted rounded-full px-2.5 py-1 text-ui">
              {link.label}
            </a>
          ))}
          <ThemeToggle />
        </div>
      </div>
    </footer>
  );
}
