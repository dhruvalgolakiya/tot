// Per-shape SVG geometry: silhouettes (as one or more filled pieces, in a 100x100
// viewBox) plus anchor points that eyes/mouth/accessories use to sit correctly on
// each shape. Cut-paper style: crisp geometric shapes (circles, squircles, stars,
// stadiums, zigzag edges) built from a few primitives, so all ten read as one set.
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
  /** Relative scale for eyes/mouth/accessory linework (the frog's eyes sit on small bumps). */
  faceScale: number;
}

export interface ShapeDef {
  /** Pieces drawn behind the body (cat ears, frog eye bumps, the bot's ears). Same color as the body. */
  back?: BodyPiece[];
  /** The main silhouette: one or more pieces. */
  body: BodyPiece[];
  /** Small cut-outs drawn over the body in the accessory color (the pear's stem and leaf). */
  ink?: BodyPiece[];
  anchors: ShapeAnchors;
}

const circle = (cx: number, cy: number, r: number): BodyPiece => ({ cx, cy, r });

export const SHAPES: Record<MascotShape, ShapeDef> = {
  // A squircle: the plainest, friendliest shape (and Tot's).
  blob: {
    body: [{ d: "M50,15 C79,15 86,22 86,51 C86,80 79,87 50,87 C21,87 14,80 14,51 C14,22 21,15 50,15 Z" }],
    anchors: {
      headTop: { x: 50, y: 15 },
      crownWidth: 30,
      eyeLine: 47,
      eyeSpread: 13,
      mouthY: 63,
      neck: { x: 50, y: 86 },
      earL: { x: 14, y: 50 },
      earR: { x: 86, y: 50 },
      faceScale: 1,
    },
  },

  // Three paper circles on a flat-bottomed base.
  cloud: {
    body: [circle(31, 58, 16), circle(51, 43, 21), circle(70, 56, 16), { d: roundedRectPath(14, 52, 72, 28, 14) }],
    anchors: {
      headTop: { x: 51, y: 22 },
      crownWidth: 24,
      eyeLine: 55,
      eyeSpread: 12,
      mouthY: 68,
      neck: { x: 50, y: 80 },
      earL: { x: 15, y: 60 },
      earR: { x: 85, y: 60 },
      faceScale: 0.95,
    },
  },

  // A small circle on a big one, with a stem and a leaf.
  pear: {
    body: [circle(50, 41, 15), circle(50, 64, 25)],
    ink: [{ d: roundedRectPath(48.6, 17, 3.4, 11, 1.7) }, { d: "M51,22 C54,15 61,13 66,15 C63,21 57,23 51,22 Z" }],
    anchors: {
      headTop: { x: 50, y: 26 },
      crownWidth: 16,
      eyeLine: 62,
      eyeSpread: 12,
      mouthY: 76,
      neck: { x: 50, y: 52 },
      earL: { x: 26, y: 64 },
      earR: { x: 74, y: 64 },
      faceScale: 0.95,
    },
  },

  // A five-point star with just-softened corners.
  star: {
    body: [{ d: radialShape(50, 55, [39, 18, 39, 18, 39, 18, 39, 18, 39, 18], [4, 3, 4, 3, 4, 3, 4, 3, 4, 3]) }],
    anchors: {
      headTop: { x: 50, y: 18 },
      crownWidth: 14,
      eyeLine: 54,
      eyeSpread: 10,
      mouthY: 66,
      neck: { x: 50, y: 80 },
      earL: { x: 22, y: 52 },
      earR: { x: 78, y: 52 },
      faceScale: 0.85,
    },
  },

  // Two circles and a point.
  heart: {
    body: [
      circle(34, 39, 18),
      circle(66, 39, 18),
      {
        d: roundedPolygon(
          [
            { x: 17.5, y: 46 },
            { x: 50, y: 33 },
            { x: 82.5, y: 46 },
            { x: 50, y: 86 },
          ],
          [2, 2, 2, 5],
        ),
      },
    ],
    anchors: {
      headTop: { x: 50, y: 30 },
      crownWidth: 20,
      eyeLine: 47,
      eyeSpread: 13,
      mouthY: 60,
      neck: { x: 50, y: 76 },
      earL: { x: 17, y: 42 },
      earR: { x: 83, y: 42 },
      faceScale: 0.95,
    },
  },

  // A teardrop with a sharp tip.
  drop: {
    body: [{ d: "M50,13 C57,24 82,46 82,62 A32,32 0 0 1 18,62 C18,46 43,24 50,13 Z" }],
    anchors: {
      headTop: { x: 50, y: 17 },
      crownWidth: 10,
      eyeLine: 62,
      eyeSpread: 12,
      mouthY: 76,
      neck: { x: 50, y: 92 },
      earL: { x: 19, y: 66 },
      earR: { x: 81, y: 66 },
      faceScale: 0.95,
    },
  },

  // A rounded box with side ears and a nub on top.
  bot: {
    back: [
      { d: roundedRectPath(12, 41, 10, 20, 3) },
      { d: roundedRectPath(78, 41, 10, 20, 3) },
      { d: roundedRectPath(45, 14, 10, 10, 2.5) },
    ],
    body: [{ d: roundedRectPath(19, 21, 62, 60, 13) }],
    anchors: {
      headTop: { x: 50, y: 21 },
      crownWidth: 28,
      eyeLine: 47,
      eyeSpread: 13,
      mouthY: 64,
      neck: { x: 50, y: 80 },
      earL: { x: 15, y: 51 },
      earR: { x: 85, y: 51 },
      faceScale: 1,
    },
  },

  // An arch with a zigzag hem, cut with pinking shears.
  ghost: {
    body: [{ d: "M16,86 L16,50 A34,34 0 0 1 84,50 L84,86 L75.5,79 L67,86 L58.5,79 L50,86 L41.5,79 L33,86 L24.5,79 Z" }],
    anchors: {
      headTop: { x: 50, y: 16 },
      crownWidth: 30,
      eyeLine: 46,
      eyeSpread: 13,
      mouthY: 62,
      neck: { x: 50, y: 78 },
      earL: { x: 16, y: 50 },
      earR: { x: 84, y: 50 },
      faceScale: 1,
    },
  },

  // A stadium with two bumps on top for the eyes.
  frog: {
    back: [circle(32, 31, 13.5), circle(68, 31, 13.5)],
    body: [{ d: roundedRectPath(11, 35, 78, 50, 25) }],
    anchors: {
      headTop: { x: 50, y: 30 },
      crownWidth: 18,
      eyeLine: 31,
      eyeSpread: 18,
      mouthY: 61,
      neck: { x: 50, y: 84 },
      earL: { x: 11, y: 60 },
      earR: { x: 89, y: 60 },
      faceScale: 0.88,
    },
  },

  // A circle with two sharp ears.
  cat: {
    back: [
      {
        d: roundedPolygon(
          [
            { x: 18, y: 42 },
            { x: 16, y: 9 },
            { x: 44, y: 27 },
          ],
          [3, 3.5, 3],
        ),
      },
      {
        d: roundedPolygon(
          [
            { x: 82, y: 42 },
            { x: 84, y: 9 },
            { x: 56, y: 27 },
          ],
          [3, 3.5, 3],
        ),
      },
    ],
    body: [circle(50, 56, 33)],
    anchors: {
      headTop: { x: 50, y: 23 },
      crownWidth: 22,
      eyeLine: 54,
      eyeSpread: 13,
      mouthY: 68,
      neck: { x: 50, y: 88 },
      earL: { x: 17, y: 56 },
      earR: { x: 83, y: 56 },
      faceScale: 1,
    },
  },
};
