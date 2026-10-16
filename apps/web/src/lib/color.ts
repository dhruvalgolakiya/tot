/**
 * Small, self-contained color helpers for spots that fill a surface solidly with
 * `--agent-accent` (e.g. the composer's send button) and need to pick a readable
 * foreground color. Deliberately independent from the mascot system's own palette
 * math (src/components/mascot/utils.ts), which is internal to that module.
 */

/** Perceived brightness (YIQ) of a `#rrggbb` hex color, 0 (black) to 255 (white). */
function perceivedBrightness(hex: string): number {
  const clean = hex.replace("#", "");
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return (r * 299 + g * 587 + b * 114) / 1000;
}

/** Whether a solid fill of this color needs a dark (rather than light/white) foreground. */
export function isLightColor(hex: string): boolean {
  return perceivedBrightness(hex) > 165;
}
