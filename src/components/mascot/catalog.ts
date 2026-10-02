// Public catalog data: the pickable option lists, the default ("Tot") mascot, the
// randomizer, and small display helpers (mascotLabel, suggestName). This is the only
// file in the folder most callers outside mascot/ need beyond Mascot/MascotPicker.
import type { MascotAccessory, MascotEyes, MascotShape, MascotSpec } from "@shared/types";
import { hashString, hexToHsl, mulberry32, pick, specKey } from "./utils";

export const MASCOT_SHAPES: readonly MascotShape[] = [
  "blob",
  "cloud",
  "pear",
  "star",
  "heart",
  "drop",
  "bot",
  "ghost",
  "frog",
  "cat",
];

export const MASCOT_ACCESSORIES: readonly MascotAccessory[] = [
  "none",
  "glasses",
  "sunglasses",
  "bowtie",
  "beret",
  "headphones",
  "cap",
  "antenna",
  "crown",
  "scarf",
];

export const MASCOT_EYES: readonly MascotEyes[] = ["dots", "happy", "wide", "sleepy"];

/** Twelve curated swatches — saturated enough to read clearly on TOT's near-black canvas. */
export const MASCOT_COLORS: readonly string[] = [
  "#a78bfa", // violet (brand)
  "#22d3ee", // cyan (brand)
  "#f472b6", // pink
  "#fb7185", // rose
  "#fbbf24", // amber
  "#facc15", // yellow
  "#4ade80", // green
  "#34d399", // emerald
  "#60a5fa", // blue
  "#818cf8", // indigo
  "#fb923c", // orange
  "#f87171", // red
];

/**
 * Tot, the default agent's mascot: a violet blob (brand hue) with headphones — the
 * derived palette (see utils.ts) pulls its highlight toward TOT's cyan automatically,
 * so it reads as the violet→cyan brand duotone without any special-casing here.
 */
export const defaultMascot: MascotSpec = {
  shape: "blob",
  color: "#a78bfa",
  accessory: "headphones",
  eyes: "dots",
};

/**
 * A random mascot. Pass `seed` for a deterministic result (same seed -> same spec,
 * useful for e.g. deriving a mascot from an agent id); omit it for true randomness.
 */
export function randomMascot(seed?: string): MascotSpec {
  const rand = seed === undefined ? Math.random : mulberry32(hashString(seed));
  return {
    shape: pick(MASCOT_SHAPES, rand),
    color: pick(MASCOT_COLORS, rand),
    accessory: pick(MASCOT_ACCESSORIES, rand),
    eyes: pick(MASCOT_EYES, rand),
  };
}

const COLOR_NAMES: readonly [max: number, name: string][] = [
  [15, "Red"],
  [40, "Orange"],
  [65, "Amber"],
  [80, "Yellow"],
  [160, "Green"],
  [185, "Teal"],
  [200, "Cyan"],
  [230, "Blue"],
  [270, "Indigo"],
  [295, "Violet"],
  [330, "Pink"],
  [345, "Rose"],
  [360, "Red"],
];

function colorName(hex: string): string {
  const [h, s, l] = hexToHsl(hex);
  if (s < 12) return l > 70 ? "White" : l < 25 ? "Charcoal" : "Gray";
  return COLOR_NAMES.find(([max]) => h <= max)?.[1] ?? "Colorful";
}

const ACCESSORY_LABEL: Record<MascotAccessory, string> = {
  none: "",
  glasses: "Glasses",
  sunglasses: "Sunglasses",
  bowtie: "a Bowtie",
  beret: "a Beret",
  headphones: "Headphones",
  cap: "a Cap",
  antenna: "an Antenna",
  crown: "a Crown",
  scarf: "a Scarf",
};

const SHAPE_LABEL: Record<MascotShape, string> = {
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

/** Human-readable description of a spec, e.g. "Violet Blob with Headphones" — used as the default aria-label. */
export function mascotLabel(spec: MascotSpec): string {
  const base = `${colorName(spec.color)} ${SHAPE_LABEL[spec.shape]}`;
  const accessory = ACCESSORY_LABEL[spec.accessory];
  return accessory ? `${base} with ${accessory}` : base;
}

const NAME_BANK: Record<MascotShape, readonly string[]> = {
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

/** Deterministically suggests a playful name for a spec (same spec -> same suggestion). */
export function suggestName(spec: MascotSpec): string {
  const rand = mulberry32(hashString(`name::${specKey(spec)}`));
  return pick(NAME_BANK[spec.shape], rand);
}
