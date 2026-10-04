// Internal helpers: deterministic hashing, a seedable PRNG, and small color-math
// utilities used to derive each mascot's shaded palette from a single base color.
// Nothing here is exported through index.ts — it's implementation detail.
import type { MascotSpec } from "@shared/types";

/** Stable string key for a spec — used for hashing (blink timing, "random" mascot, name suggestions). */
export function specKey(spec: MascotSpec): string {
  return `${spec.shape}|${spec.color.toLowerCase()}|${spec.accessory}|${spec.eyes}`;
}

/** FNV-1a 32-bit hash. Deterministic across runs/browsers — good enough to seed a PRNG or derive CSS delays. */
export function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: a tiny, fast, deterministic PRNG from a 32-bit seed. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic 0..1 float from a string + a "salt", so several delays can be decorrelated. */
export function hashFloat(seed: string, salt: string): number {
  return mulberry32(hashString(`${seed}::${salt}`))();
}

export function pick<T>(list: readonly T[], rand: () => number): T {
  return list[Math.floor(rand() * list.length) % list.length];
}

const clamp = (n: number, min: number, max: number) => Math.min(max, Math.max(min, n));

function normalizeHex(hex: string): string {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3)
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return "808080"; // never throw on bad custom input — fall back to mid gray
  return h;
}

export function hexToRgb(hex: string): [number, number, number] {
  const h = normalizeHex(hex);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function rgbToHex(r: number, g: number, b: number): string {
  const c = (n: number) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

export function hexToHsl(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l * 100];
  const d = max - min;
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return [h, s * 100, l * 100];
}

export function hslToHex(h: number, s: number, l: number): string {
  const H = ((h % 360) + 360) % 360;
  const S = clamp(s, 0, 100) / 100;
  const L = clamp(l, 0, 100) / 100;
  const c = (1 - Math.abs(2 * L - 1)) * S;
  const x = c * (1 - Math.abs(((H / 60) % 2) - 1));
  const m = L - c / 2;
  let r = 0;
  let g = 0;
  let b = 0;
  if (H < 60) [r, g, b] = [c, x, 0];
  else if (H < 120) [r, g, b] = [x, c, 0];
  else if (H < 180) [r, g, b] = [0, c, x];
  else if (H < 240) [r, g, b] = [0, x, c];
  else if (H < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return rgbToHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}

/** Shortest-path hue interpolation (circular): pulls `from` toward `to` by fraction `t`. */
function blendHue(from: number, to: number, t: number): number {
  const diff = ((to - from + 540) % 360) - 180;
  return ((from + diff * t + 360) % 360 + 360) % 360;
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** Lifts very dark colors so they never disappear against TOT's near-black canvas. */
function ensureReadable(hex: string, minLightness: number): string {
  const [h, s, l] = hexToHsl(hex);
  return l < minLightness ? hslToHex(h, clamp(s + 4, 0, 100), minLightness) : hex;
}

export interface MascotPalette {
  /** The body: one flat color, lifted off black and saturated enough to pop on both canvases. */
  base: string;
  /** The "fold": the same hue a step darker, for the diagonal shadow across the lower right. */
  fold: string;
  /** Pupils, mouth and the sunglasses: one near-black shared by every mascot, so they read as one family. */
  ink: string;
  /** Eye whites. */
  paper: string;
  /** The tongue inside an open mouth. */
  tongue: string;
  /** A light tint of the body, for the soft disc behind a mascot on stage (MascotStage, the picker). */
  glow: string;
}

/** Shared by every mascot (see MascotPalette). Hats and other cut-outs use `currentColor` instead: see styles.ts. */
export const MASCOT_INK = "#18171d";
export const MASCOT_PAPER = "#ffffff";

/**
 * Derives a mascot's palette from one base color. Cut-paper mascots are flat: a body color and a darker fold,
 * with the eyes, mouth and cut-outs in shared tones. Pale or muddy custom colors are pushed toward a clear,
 * saturated mid-tone so every mascot reads as a bright piece of paper on either canvas.
 */
export function derivePalette(hex: string): MascotPalette {
  const raw = ensureReadable(hex, 34);
  const [h, s0, l0] = hexToHsl(raw);
  const s = clamp(s0 + 6, 48, 96);
  const l = clamp(l0, 48, 74);
  return {
    base: hslToHex(h, s, l),
    fold: hslToHex(h, clamp(s + 4, 50, 100), clamp(l - 11, 36, 64)),
    ink: MASCOT_INK,
    paper: MASCOT_PAPER,
    tongue: hslToHex(blendHue(h, 350, 0.75), 90, 74),
    glow: hslToHex(h, clamp(s, 55, 100), clamp(l + 14, 62, 88)),
  };
}

export function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${clamp(alpha, 0, 1)})`;
}
