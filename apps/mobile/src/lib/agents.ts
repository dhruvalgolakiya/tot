import type { Agent, AgentIsland, ComputerSummary, MascotAccessory, MascotEyes, MascotShape, MascotSpec, Settings } from "@tot/shared/types";
import type { ImageSourcePropType } from "react-native";

/**
 * An agent's profile choices, ported from packages/shared/islands.ts and the web's mascot catalog
 * (apps/web/src/components/mascot/catalog.ts). Ported, not imported: Metro bundles only apps/mobile/, and packages/shared/ is
 * reached for types alone.
 */

export const AGENT_ISLANDS: readonly { id: AgentIsland; name: string }[] = [
  { id: "workshop", name: "the workshop" },
  { id: "observatory", name: "the observatory" },
  { id: "tower", name: "the signal tower" },
  { id: "greenhouse", name: "the greenhouse" },
];

/** The agent's island; the first one for an agent from a paired device that predates islands. */
export function agentIsland(agent: Pick<Agent, "island">): AgentIsland {
  return AGENT_ISLANDS.some((i) => i.id === agent.island) ? agent.island : AGENT_ISLANDS[0]!.id;
}

export function islandName(island: AgentIsland): string {
  return AGENT_ISLANDS.find((i) => i.id === island)?.name ?? AGENT_ISLANDS[0]!.name;
}

/** The island for the agent at this position in creation order (round-robin), as the server would pick. */
export function defaultIsland(index: number): AgentIsland {
  return AGENT_ISLANDS[index % AGENT_ISLANDS.length]!.id;
}

/** The apps/web/public/hero/islands pictures, bundled: at night for dark mode, at dawn for light mode. */
export const ISLAND_IMAGES: Record<AgentIsland, { night: ImageSourcePropType; dawn: ImageSourcePropType }> = {
  workshop: { night: require("../../assets/islands/workshop.webp"), dawn: require("../../assets/islands/workshop-dawn.webp") },
  observatory: { night: require("../../assets/islands/observatory.webp"), dawn: require("../../assets/islands/observatory-dawn.webp") },
  tower: { night: require("../../assets/islands/tower.webp"), dawn: require("../../assets/islands/tower-dawn.webp") },
  greenhouse: { night: require("../../assets/islands/greenhouse.webp"), dawn: require("../../assets/islands/greenhouse-dawn.webp") },
};

export const TAGLINE_MAX = 40;
export const NAME_MAX = 40;

/** Twelve curated swatches, the web's MASCOT_COLORS. */
export const MASCOT_COLORS: readonly string[] = [
  "#a78bfa",
  "#22d3ee",
  "#f472b6",
  "#fb7185",
  "#fbbf24",
  "#facc15",
  "#4ade80",
  "#34d399",
  "#60a5fa",
  "#818cf8",
  "#fb923c",
  "#f87171",
];

export const MASCOT_SHAPES: Record<MascotShape, string> = {
  blob: "Blob",
  cloud: "Cloud",
  pear: "Pear",
  star: "Star",
  heart: "Heart",
  drop: "Droplet",
  bot: "Bot",
  ghost: "Ghost",
  frog: "Frog",
  cat: "Cat",
};

export const MASCOT_EYES: Record<MascotEyes, string> = { dots: "Dots", happy: "Happy", wide: "Wide", sleepy: "Sleepy" };

export const MASCOT_ACCESSORIES: Record<MascotAccessory, string> = {
  none: "None",
  glasses: "Glasses",
  sunglasses: "Sunglasses",
  bowtie: "Bowtie",
  beret: "Beret",
  headphones: "Headphones",
  cap: "Cap",
  antenna: "Antenna",
  crown: "Crown",
  scarf: "Scarf",
};

const pick = <T,>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)]!;

/** A random mascot, like the web's New agent dialog starts with. */
export function randomMascot(): MascotSpec {
  return {
    shape: pick(Object.keys(MASCOT_SHAPES) as MascotShape[]),
    color: pick(MASCOT_COLORS),
    accessory: pick(Object.keys(MASCOT_ACCESSORIES) as MascotAccessory[]),
    eyes: pick(Object.keys(MASCOT_EYES) as MascotEyes[]),
  };
}

/** A few playful names per shape (the web's NAME_BANK), so a new agent starts with one. */
const NAMES: Record<MascotShape, readonly string[]> = {
  blob: ["Bloop", "Squish", "Puddin", "Glob", "Jelly", "Bubble"],
  cloud: ["Nimbus", "Puff", "Misty", "Drift", "Wisp", "Cirrus"],
  pear: ["Perry", "Beri", "Juicy", "Pip", "Nectar", "Comice"],
  star: ["Stella", "Sparky", "Twinkle", "Nova", "Astra", "Cosmo"],
  heart: ["Cordy", "Sweetie", "Amor", "Pulse", "Valen", "Rosy"],
  drop: ["Splash", "Dewy", "Ripple", "Marin", "Puddle", "Trickle"],
  bot: ["Tot", "Circuit", "Byte", "Pixel", "Volt", "Rune"],
  ghost: ["Boo", "Wisp", "Spooky", "Haze", "Lumen", "Shade"],
  frog: ["Hopper", "Lily", "Todd", "Ribbit", "Kero", "Fern"],
  cat: ["Miso", "Whiskers", "Tobi", "Mochi", "Yuki", "Pounce"],
};

export function suggestName(spec: MascotSpec): string {
  return pick(NAMES[spec.shape]);
}

/**
 * The agent's computer in one line, as the web's computer chip says it: on, asleep, not started, or off for
 * everyone when Settings → Computer is off.
 */
export function computerLine(computer: ComputerSummary | null, mode: Settings["computer"]["mode"] | undefined): string {
  if (mode === "off") return "Off · computers are off in Settings";
  if (!computer) return "Not started · starts when it's first needed";
  const state = computer.state === "stopped" ? "Asleep" : computer.state === "running" ? "On" : computer.state.charAt(0).toUpperCase() + computer.state.slice(1);
  return [state, computer.label, computer.error].filter(Boolean).join(" · ");
}
