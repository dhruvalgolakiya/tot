import type { ComponentType, CSSProperties, ReactNode } from "react";
import { Activity, Map, MessageCircleQuestion, PackageOpen, StickyNote, Trash2, type LucideIcon } from "lucide-react";
import { Mascot } from "../../src/components/mascot";
import { Logo } from "../../src/components/ui/Logo";
import { Brains } from "../apps/Brains";
import { Calendar } from "../apps/Calendar";
import { Help } from "../apps/Help";
import { Maker } from "../apps/Maker";
import { Readme } from "../apps/Readme";
import { RoadmapApp } from "../apps/RoadmapApp";
import { Rules } from "../apps/Rules";
import { Terminal } from "../apps/Terminal";
import { TotApp } from "../apps/TotApp";
import { Trash } from "../apps/Trash";
import { WhatsInside } from "../apps/WhatsInside";
import { crew } from "../crew";
import type { AppId } from "./ids";

export interface AppDef {
  /** Dock, icon and home-screen label. */
  name: string;
  /** Window title. */
  title: string;
  /** One line for the launcher and the Apps menu. */
  blurb: string;
  /** Extra words the launcher matches on. */
  keywords?: string;
  /** Preferred window size on the desktop (shrunk to fit smaller screens). */
  size: { w: number; h: number };
  Body: ComponentType;
  /** Always dark, whatever the theme (the terminal). */
  dark?: boolean;
}

export const APPS: Record<AppId, AppDef> = {
  readme: { name: "README", title: "README.md", blurb: "The pitch, in one page", keywords: "about intro", size: { w: 540, h: 504 }, Body: Readme },
  tot: {
    name: "TOT",
    title: "TOT · Flaky checkout test",
    blurb: "Watch Tot fix a flaky test, live",
    keywords: "chat demo tasks branch",
    size: { w: 760, h: 600 },
    Body: TotApp,
  },
  features: {
    name: "What's inside",
    title: "What's inside",
    blurb: "Everything TOT does today",
    keywords: "features shipped",
    size: { w: 840, h: 560 },
    Body: WhatsInside,
  },
  maker: {
    name: "Mascot Maker",
    title: "Mascot Maker",
    blurb: "Build a mascot and try its moods",
    keywords: "agents avatar character face",
    size: { w: 440, h: 620 },
    Body: Maker,
  },
  calendar: {
    name: "Calendar",
    title: "Calendar · Tuesday",
    blurb: "A normal day with your team",
    keywords: "routines schedule day",
    size: { w: 560, h: 640 },
    Body: Calendar,
  },
  brains: {
    name: "Brains",
    title: "Brains",
    blurb: "Claude, ChatGPT and who picks what",
    keywords: "models usage limits claude chatgpt subscription",
    size: { w: 600, h: 560 },
    Body: Brains,
  },
  terminal: {
    name: "Terminal",
    title: "Terminal · zsh",
    blurb: "Install TOT in a few commands",
    keywords: "install setup get download start",
    size: { w: 640, h: 460 },
    Body: Terminal,
    dark: true,
  },
  roadmap: {
    name: "Roadmap",
    title: "Roadmap.md",
    blurb: "Shipped, next and later",
    keywords: "plan future next",
    size: { w: 680, h: 600 },
    Body: RoadmapApp,
  },
  help: { name: "Help", title: "Help · Ask Tot", blurb: "Questions, answered by Tot", keywords: "faq", size: { w: 480, h: 620 }, Body: Help },
  trash: { name: "Trash", title: "Trash", blurb: "What TOT threw away", keywords: "deleted", size: { w: 480, h: 540 }, Body: Trash },
  rules: {
    name: "House rules",
    title: "House rules.txt",
    blurb: "What TOT will never do",
    keywords: "safety never merge push sticky note",
    size: { w: 380, h: 460 },
    Body: Rules,
  },
};

/** Every app, in the order the launcher and the Apps menu list them. */
export const APP_ORDER: AppId[] = ["tot", "features", "maker", "calendar", "brains", "terminal", "roadmap", "help", "readme", "rules", "trash"];

/** Every app icon sits on the same neutral tile; one tinted glyph tells them apart (light and dark tints). */
const GLYPHS: Partial<Record<AppId, { icon: LucideIcon; light: string; dark: string }>> = {
  features: { icon: PackageOpen, light: "#2563eb", dark: "#60a5fa" },
  brains: { icon: Activity, light: "#059669", dark: "#34d399" },
  roadmap: { icon: Map, light: "#d97706", dark: "#fbbf24" },
  help: { icon: MessageCircleQuestion, light: "#7c3aed", dark: "#a78bfa" },
  rules: { icon: StickyNote, light: "#ca8a04", dark: "#facc15" },
  trash: { icon: Trash2, light: "#52525b", dark: "#d4d4d8" },
};

/** An app's icon: the TOT mark, a mascot, a date, a prompt or a tinted glyph, on a neutral tile. */
export function AppIcon({ id, size = 48 }: { id: AppId; size?: number }) {
  const box = { width: size, height: size, borderRadius: Math.round(size * 0.26) };
  const tile = (children: ReactNode) => (
    <span style={box} className="app-tile grid shrink-0 place-items-center">
      {children}
    </span>
  );

  if (id === "tot") return tile(<Logo className="w-[62%]" />);
  if (id === "maker") return tile(<Mascot spec={crew.mochi.spec} state="idle" size={Math.round(size * 0.76)} />);
  if (id === "calendar") {
    const now = new Date();
    return tile(
      <span className="flex flex-col items-center leading-none">
        <span style={{ fontSize: size * 0.19 }} className="font-semibold tracking-wide text-[#ef4444] uppercase">
          {now.toLocaleDateString("en-US", { weekday: "short" })}
        </span>
        <span style={{ fontSize: size * 0.44, marginTop: size * 0.02 }} className="font-display font-medium text-fg-strong">
          {now.getDate()}
        </span>
      </span>,
    );
  }
  if (id === "terminal") {
    return tile(
      <span style={{ fontSize: size * 0.3 }} className="font-mono font-semibold tracking-tight text-fg-strong">
        &gt;_
      </span>,
    );
  }
  if (id === "readme") {
    return (
      <span style={box} className="app-paper flex flex-col justify-center gap-[9%] px-[22%]">
        <span className="h-[7%] w-3/5 rounded-full bg-[#3f3f46]" />
        <span className="h-[5%] rounded-full bg-[#a1a1aa]" />
        <span className="h-[5%] rounded-full bg-[#a1a1aa]" />
        <span className="h-[5%] w-4/5 rounded-full bg-[#a1a1aa]" />
      </span>
    );
  }
  const { icon: Icon, light, dark } = GLYPHS[id]!;
  const glyph = Math.round(size * 0.46);
  return tile(
    <Icon
      className="app-glyph"
      strokeWidth={1.9}
      style={{ width: glyph, height: glyph, "--glyph-light": light, "--glyph-dark": dark } as CSSProperties}
    />,
  );
}
