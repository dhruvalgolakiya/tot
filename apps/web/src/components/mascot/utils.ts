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
  /** Safe, punched-up base color (lifted off pure black and boosted so it pops on #0b0b0f). */
  base: string;
  /** Top-left highlight tone (gradient stop), gently pulled toward TOT's cyan. */
  light: string;
  /** Bottom-right shade tone (gradient stop), gently pulled toward TOT's violet — kept
   *  light rather than dark, so shading reads as a shade of the toy, not mud. */
  dark: string;
  /** Near-black, low-saturation tone for eyes/mouth/small ink details — deliberately
   *  desaturated so it reads as "near-black", not just a darker version of the body hue. */
  ink: string;
  /** A light accent tone for small details (the beret's nub, the scarf's stripe, sleeping z's). */
  outline: string;
  /** Bright tone for glow/shadow effects (MascotStage). */
  glow: string;
}

const TOT_CYAN_HUE = 189; // #22d3ee
const TOT_VIOLET_HUE = 258; // #a78bfa

/**
 * Derives a full shading palette from one base color: a light top-left highlight, a
 * gently shaded bottom tone, a near-black "ink" for eyes, mouth and accessories, and a
 * light accent tone, all in the same family, with a gentle universal pull toward TOT's
 * violet→cyan duotone so every mascot carries a bit of house DNA without losing its own
 * hue. Saturation/lightness are actively pushed up (not just passed through) so pale or
 * muddy custom colors still read as a bright, colorful toy against the near-black canvas.
 */
export function derivePalette(hex: string): MascotPalette {
  const raw = ensureReadable(hex, 34);
  const [h, s0, l0] = hexToHsl(raw);
  const s = clamp(s0 + 10, 52, 100);
  const l = clamp(l0, 42, 80);
  const base = hslToHex(h, s, l);
  const light = hslToHex(blendHue(h, TOT_CYAN_HUE, 0.14), clamp(s + 4, 60, 100), clamp(l + 10, 58, 88));
  const dark = hslToHex(blendHue(h, TOT_VIOLET_HUE, 0.14), clamp(s + 8, 60, 100), clamp(l - 9, 36, 76));
  const ink = hslToHex(h, clamp(s0 * 0.4, 0, 35), clamp(l0 * 0.12, 3, 9));
  const outline = hslToHex(h, clamp(s + 2, 55, 100), clamp(l + 8, 55, 92));
  return { base, light, dark, ink, outline, glow: light };
}

export function withAlpha(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${clamp(alpha, 0, 1)})`;
}
