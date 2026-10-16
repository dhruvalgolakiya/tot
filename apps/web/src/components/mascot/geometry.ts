// Per-shape SVG geometry: silhouettes (as one or more filled pieces, in a 100x100
// viewBox) plus anchor points that eyes/mouth/accessories use to sit correctly on
// each shape. Every silhouette is built from the same primitives — `roundedPolygon`
// and `radialShape` — so all ten shapes read as one squishy, rounded family.
import type { MascotShape } from "@shared/types";

type Pt = { x: number; y: number };

const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
const scalePt = (a: Pt, s: number): Pt => ({ x: a.x * s, y: a.y * s });
const len = (a: Pt): number => Math.hypot(a.x, a.y);
const norm = (a: Pt): Pt => {
  const l = len(a) || 1;
  return { x: a.x / l, y: a.y / l };
};
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * A closed path through `points`, each corner rounded with a quadratic curve.
 * `radius` may be one number (all corners) or one per point. This is the single
 * building block behind every mascot silhouette — it's what gives the family its
 * shared "squishy" character.
 */
function roundedPolygon(points: Pt[], radius: number | number[]): string {
  const n = points.length;
  const radii = Array.isArray(radius) ? radius : points.map(() => radius);
  const d: string[] = [];
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n];
    const curr = points[i];
    const next = points[(i + 1) % n];
    const toPrev = norm(sub(prev, curr));
    const toNext = norm(sub(next, curr));
    const r = Math.min(radii[i], len(sub(prev, curr)) * 0.48, len(sub(next, curr)) * 0.48);
    const p1 = add(curr, scalePt(toPrev, r));
    const p2 = add(curr, scalePt(toNext, r));
    d.push(`${i === 0 ? "M" : "L"}${round2(p1.x)},${round2(p1.y)}`);
    d.push(`Q${round2(curr.x)},${round2(curr.y)} ${round2(p2.x)},${round2(p2.y)}`);
  }
  d.push("Z");
  return d.join(" ");
}

/** A rounded polygon laid out radially around (cx, cy): one radius per angular step. */
function radialShape(
  cx: number,
  cy: number,
  radii: number[],
  cornerRadius: number | number[],
  opts: { rotateDeg?: number; scaleX?: number; scaleY?: number } = {},
): string {
  const { rotateDeg = -90, scaleX = 1, scaleY = 1 } = opts;
  const n = radii.length;
  const pts = radii.map((r, i) => {
    const angle = ((rotateDeg + (i / n) * 360) * Math.PI) / 180;
    return { x: cx + Math.cos(angle) * r * scaleX, y: cy + Math.sin(angle) * r * scaleY };
  });
  return roundedPolygon(pts, cornerRadius);
}

function roundedRectPath(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h / 2);
  return [
    `M${x + rr},${y}`,
    `H${x + w - rr}`,
    `Q${x + w},${y} ${x + w},${y + rr}`,
    `V${y + h - rr}`,
    `Q${x + w},${y + h} ${x + w - rr},${y + h}`,
    `H${x + rr}`,
    `Q${x},${y + h} ${x},${y + h - rr}`,
    `V${y + rr}`,
    `Q${x},${y} ${x + rr},${y}`,
    "Z",
  ].join(" ");
}

export type BodyPiece = { d: string } | { cx: number; cy: number; r: number };

export interface ShapeAnchors {
  /** Top-center of the head/body, for hats/crown/antenna. */
  headTop: Pt;
  /** Width available at headTop, for sizing hats/crowns. */
  crownWidth: number;
  eyeLine: number;
  eyeSpread: number;
  mouthY: number;
  /** For bowtie/scarf. */
  neck: Pt;
  earL: Pt;
  earR: Pt;
  /** Relative scale for eyes/mouth/accessory linework (frog's face sits on small bumps). */
  faceScale: number;
}

export interface ShapeDef {
  /** Pieces drawn behind the head (cat ears, frog eye-bumps). Same body gradient. */
  back?: BodyPiece[];
  /** The main silhouette. Usually one piece. */
  body: BodyPiece[];
  /** Small ink-colored details drawn over the body (e.g. the pear's stem). */
  ink?: BodyPiece[];
  highlight: { cx: number; cy: number; rx: number; ry: number; rotate?: number };
  anchors: ShapeAnchors;
}

export const SHAPES: Record<MascotShape, ShapeDef> = {
  blob: {
    body: [{ d: radialShape(50, 54, [33, 39, 35, 38, 33, 37, 35, 39, 36, 33], 20) }],
    highlight: { cx: 36, cy: 34, rx: 13, ry: 9, rotate: -18 },
    anchors: {
      headTop: { x: 50, y: 17 },
      crownWidth: 28,
      eyeLine: 50,
      eyeSpread: 12,
      mouthY: 64,
      neck: { x: 50, y: 85 },
      earL: { x: 14, y: 52 },
      earR: { x: 86, y: 52 },
      faceScale: 1,
    },
  },

  cloud: {
    // Explicit points (not a pure radial shape) so the 3 bumps get a big rounding
    // radius while the notches between them get a small one — a pure radialShape
    // over-smooths the notches away and the bumps disappear into one blob.
    body: [
      {
        d: roundedPolygon(
          [
            { x: 18, y: 70 },
            { x: 13, y: 50 },
            { x: 28, y: 31 },
            { x: 42, y: 38 },
            { x: 50, y: 19 },
            { x: 58, y: 38 },
            { x: 72, y: 31 },
            { x: 87, y: 50 },
            { x: 82, y: 70 },
            { x: 50, y: 77 },
          ],
          [12, 14, 17, 8, 18, 8, 17, 14, 12, 15],
        ),
      },
    ],
    highlight: { cx: 34, cy: 38, rx: 12, ry: 8, rotate: -12 },
    anchors: {
      headTop: { x: 50, y: 24 },
      crownWidth: 24,
      eyeLine: 52,
      eyeSpread: 13,
      mouthY: 62,
      neck: { x: 50, y: 75 },
      earL: { x: 15, y: 52 },
      earR: { x: 85, y: 52 },
      faceScale: 1,
    },
  },

  pear: {
    // Explicit points for a real waist: small radius at the shoulders/waist pinches it
    // in, then a big radius at the belly points flares it back out into a round base.
    body: [
      {
        d: roundedPolygon(
          [
            { x: 50, y: 27 },
            { x: 61, y: 33 },
            { x: 55, y: 45 },
            { x: 80, y: 64 },
            { x: 50, y: 90 },
            { x: 20, y: 64 },
            { x: 45, y: 45 },
            { x: 39, y: 33 },
          ],
          [7, 9, 7, 27, 22, 27, 7, 9],
        ),
      },
    ],
    ink: [
      { d: "M47,25 C46,18 51,13 57,15 C54,17 52,20 52,25 Z" },
      { d: "M51,17 C57,13 64,15 63,21 C57,22 52,20 51,17 Z" },
    ],
    highlight: { cx: 37, cy: 56, rx: 12, ry: 9, rotate: -14 },
    anchors: {
      headTop: { x: 50, y: 22 },
      crownWidth: 16,
      eyeLine: 58,
      eyeSpread: 13,
      mouthY: 71,
      neck: { x: 50, y: 45 },
      earL: { x: 23, y: 60 },
      earR: { x: 77, y: 60 },
      faceScale: 1,
    },
  },

  star: {
    body: [
      {
        d: radialShape(50, 55, [36, 16, 36, 16, 36, 16, 36, 16, 36, 16], [10, 5, 10, 5, 10, 5, 10, 5, 10, 5]),
      },
    ],
    highlight: { cx: 39, cy: 40, rx: 10, ry: 7, rotate: -20 },
    anchors: {
      headTop: { x: 50, y: 19 },
      crownWidth: 22,
      eyeLine: 54,
      eyeSpread: 13,
      mouthY: 66,
      neck: { x: 50, y: 87 },
      earL: { x: 18, y: 55 },
      earR: { x: 82, y: 55 },
      faceScale: 0.95,
    },
  },

  heart: {
    body: [
      {
        d: roundedPolygon(
          [
            { x: 50, y: 34 },
            { x: 27, y: 19 },
            { x: 12, y: 43 },
            { x: 50, y: 90 },
            { x: 88, y: 43 },
            { x: 73, y: 19 },
          ],
          [6, 15, 15, 19, 15, 15],
        ),
      },
    ],
    highlight: { cx: 35, cy: 38, rx: 10, ry: 7, rotate: -25 },
    anchors: {
      headTop: { x: 50, y: 26 },
      crownWidth: 24,
      eyeLine: 46,
      eyeSpread: 14,
      mouthY: 58,
      neck: { x: 50, y: 80 },
      earL: { x: 16, y: 40 },
      earR: { x: 84, y: 40 },
      faceScale: 1,
    },
  },

  drop: {
    // A near-zero radius at the apex keeps a genuinely sharp point (the neighboring
    // edges are long, so roundedPolygon's clamp never rounds it away); the wide-set
    // side points get a big radius so the bottom still reads as a soft round bulb.
    body: [
      {
        d: roundedPolygon(
          [
            { x: 50, y: 14 },
            { x: 69, y: 31 },
            { x: 83, y: 59 },
            { x: 50, y: 89 },
            { x: 17, y: 59 },
            { x: 31, y: 31 },
          ],
          [1.5, 15, 32, 32, 32, 15],
        ),
      },
    ],
    highlight: { cx: 40, cy: 52, rx: 10, ry: 8, rotate: -16 },
    anchors: {
      headTop: { x: 50, y: 23 },
      crownWidth: 12,
      eyeLine: 62,
      eyeSpread: 12,
      mouthY: 75,
      neck: { x: 50, y: 92 },
      earL: { x: 21, y: 66 },
      earR: { x: 79, y: 66 },
      faceScale: 0.95,
    },
  },

  bot: {
    // A tighter corner radius than the rest of the family so it still reads as a
    // rounded screen/device face rather than another blob; flat-ish top is antenna-ready.
    body: [{ d: roundedRectPath(20, 18, 60, 66, 11) }],
    highlight: { cx: 36, cy: 33, rx: 12, ry: 9, rotate: -15 },
    anchors: {
      headTop: { x: 50, y: 19 },
      crownWidth: 26,
      eyeLine: 46,
      eyeSpread: 14,
      mouthY: 62,
      neck: { x: 50, y: 82 },
      earL: { x: 23, y: 46 },
      earR: { x: 77, y: 46 },
      faceScale: 1,
    },
  },

  ghost: {
    // Dome + 4 true semicircular scallops (alternating sweep flag) for a hem that
    // reads as a clean wavy edge at any size, instead of the barely-there wobble a
    // freehand curve gives once it's shrunk to 32px.
    body: [
      {
        d: "M50,12 C69,12 84,28 84,49 L84,71 A8.5,8.5 0 0,1 67,71 A8.5,8.5 0 0,0 50,71 A8.5,8.5 0 0,1 33,71 A8.5,8.5 0 0,0 16,71 L16,49 C16,28 31,12 50,12 Z",
      },
    ],
    highlight: { cx: 37, cy: 34, rx: 12, ry: 9, rotate: -15 },
    anchors: {
      headTop: { x: 50, y: 18 },
      crownWidth: 28,
      eyeLine: 44,
      eyeSpread: 13,
      mouthY: 56,
      neck: { x: 50, y: 68 },
      earL: { x: 18, y: 44 },
      earR: { x: 82, y: 44 },
      faceScale: 1,
    },
  },

  frog: {
    back: [
      { cx: 35, cy: 29, r: 13 },
      { cx: 65, cy: 29, r: 13 },
    ],
    body: [{ d: radialShape(50, 60, [30, 32, 34, 35, 33, 35, 33, 35, 34, 32], 18, { scaleX: 1.05, scaleY: 0.88 }) }],
    highlight: { cx: 38, cy: 50, rx: 11, ry: 8, rotate: -10 },
    anchors: {
      headTop: { x: 50, y: 17 },
      crownWidth: 20,
      eyeLine: 29,
      eyeSpread: 16,
      mouthY: 58,
      neck: { x: 50, y: 84 },
      earL: { x: 18, y: 58 },
      earR: { x: 82, y: 58 },
      faceScale: 0.55,
    },
  },

  cat: {
    back: [
      { d: roundedPolygon([{ x: 19, y: 38 }, { x: 12, y: 9 }, { x: 39, y: 26 }], [4, 8, 4]) },
      { d: roundedPolygon([{ x: 81, y: 38 }, { x: 88, y: 9 }, { x: 61, y: 26 }], [4, 8, 4]) },
    ],
    body: [{ d: radialShape(50, 56, [33, 34, 35, 33, 35, 36, 35, 33, 35, 34], 20) }],
    highlight: { cx: 37, cy: 38, rx: 12, ry: 9, rotate: -14 },
    anchors: {
      headTop: { x: 50, y: 12 },
      crownWidth: 20,
      eyeLine: 52,
      eyeSpread: 13,
      mouthY: 64,
      neck: { x: 50, y: 86 },
      earL: { x: 18, y: 50 },
      earR: { x: 82, y: 50 },
      faceScale: 1,
    },
  },
};
