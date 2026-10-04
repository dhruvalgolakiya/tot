import type { ComponentType } from "react";
import { Activity, Map, MessageCircleQuestion, PackageOpen, StickyNote, Trash2, type LucideIcon } from "lucide-react";
import { Mascot } from "../../src/components/mascot";
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
  /** Preferred window size on the desktop (shrunk to fit smaller screens). */
  size: { w: number; h: number };
  Body: ComponentType;
  /** Always dark, whatever the theme (the terminal). */
  dark?: boolean;
}

export const APPS: Record<AppId, AppDef> = {
  readme: { name: "README", title: "README.md", size: { w: 540, h: 504 }, Body: Readme },
  tot: { name: "TOT", title: "TOT · Flaky checkout test", size: { w: 760, h: 600 }, Body: TotApp },
  features: { name: "What's inside", title: "What's inside", size: { w: 840, h: 560 }, Body: WhatsInside },
  maker: { name: "Mascot Maker", title: "Mascot Maker", size: { w: 440, h: 620 }, Body: Maker },
  calendar: { name: "Calendar", title: "Calendar · Tuesday", size: { w: 560, h: 640 }, Body: Calendar },
  brains: { name: "Brains", title: "Brains", size: { w: 600, h: 560 }, Body: Brains },
  terminal: { name: "Terminal", title: "Terminal · zsh", size: { w: 640, h: 460 }, Body: Terminal, dark: true },
  roadmap: { name: "Roadmap", title: "Roadmap.md", size: { w: 680, h: 600 }, Body: RoadmapApp },
  help: { name: "Help", title: "Help · Ask Tot", size: { w: 480, h: 620 }, Body: Help },
  trash: { name: "Trash", title: "Trash", size: { w: 480, h: 540 }, Body: Trash },
  rules: { name: "House rules", title: "House rules.txt", size: { w: 380, h: 460 }, Body: Rules },
};

/** Gradient tiles with a white glyph (icon art, so fixed colors rather than theme tokens). */
const TILES: Partial<Record<AppId, { icon: LucideIcon; from: string; to: string; ink?: string }>> = {
  features: { icon: PackageOpen, from: "#60a5fa", to: "#2563eb" },
  brains: { icon: Activity, from: "#34d399", to: "#059669" },
  roadmap: { icon: Map, from: "#fbbf24", to: "#f97316" },
  help: { icon: MessageCircleQuestion, from: "#a78bfa", to: "#7c3aed" },
  rules: { icon: StickyNote, from: "#fef08a", to: "#facc15", ink: "#713f12" },
};

/** An app's icon: a rounded tile, the TOT logo, a calendar page, a mascot or a terminal. */
export function AppIcon({ id, size = 48 }: { id: AppId; size?: number }) {
  const radius = Math.round(size * 0.24);
  const box = { width: size, height: size, borderRadius: radius };
  const glyph = Math.round(size * 0.5);
  const shadow = "0 1px 2px rgb(0 0 0 / 0.2), inset 0 1px 0 rgb(255 255 255 / 0.25)";

  if (id === "tot") return <img src="/tot.svg" alt="" style={box} className="block" />;
  if (id === "calendar") {
    const now = new Date();
    return (
      <span style={{ ...box, boxShadow: shadow }} className="flex flex-col items-center justify-center bg-fixed-white leading-none">
        <span style={{ fontSize: size * 0.2 }} className="font-semibold text-[#ef4444] uppercase">
          {now.toLocaleDateString("en-US", { weekday: "short" })}
        </span>
        <span style={{ fontSize: size * 0.48 }} className="font-display font-medium text-[#111]">
          {now.getDate()}
        </span>
      </span>
    );
  }
  if (id === "maker") {
    return (
      <span
        style={{ ...box, boxShadow: shadow, background: "linear-gradient(160deg, #fce7f3, #f9a8d4)" }}
        className="grid place-items-center"
      >
        <Mascot spec={crew.mochi.spec} state="idle" size={Math.round(size * 0.78)} />
      </span>
    );
  }
  if (id === "terminal") {
    return (
      <span
        style={{ ...box, boxShadow: shadow, background: "linear-gradient(160deg, #3f3f46, #09090b)", fontSize: size * 0.32 }}
        className="flex items-start p-[14%] font-mono font-semibold text-fixed-white"
      >
        &gt;_
      </span>
    );
  }
  if (id === "trash") {
    return (
      <span
        style={{ ...box, boxShadow: shadow }}
        className="grid place-items-center border border-[rgb(255_255_255/0.3)] bg-[rgb(255_255_255/0.25)] text-fg backdrop-blur"
      >
        <Trash2 style={{ width: glyph, height: glyph }} />
      </span>
    );
  }
  if (id === "readme") {
    return (
      <span style={{ ...box, boxShadow: shadow }} className="flex flex-col justify-center gap-[9%] bg-fixed-white px-[20%]">
        <span className="h-[7%] w-3/5 rounded-full bg-[#3f3f46]" />
        <span className="h-[5%] rounded-full bg-[#a1a1aa]" />
        <span className="h-[5%] rounded-full bg-[#a1a1aa]" />
        <span className="h-[5%] w-4/5 rounded-full bg-[#a1a1aa]" />
      </span>
    );
  }
  const tile = TILES[id]!;
  const Icon = tile.icon;
  return (
    <span
      style={{ ...box, boxShadow: shadow, background: `linear-gradient(160deg, ${tile.from}, ${tile.to})`, color: tile.ink ?? "#fff" }}
      className="grid place-items-center"
    >
      <Icon style={{ width: glyph, height: glyph }} strokeWidth={2} />
    </span>
  );
}
