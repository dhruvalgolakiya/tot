// The ten accessories. Most render in the mascot's own "ink" tone (a near-black tint
// of its body color) so they read as a neutral accessory on a colorful character —
// crown is the deliberate exception, rendered in a fixed gold (crowns read as gold
// regardless of the wearer). Positioned using each shape's anchor points so the same
// accessory code works across all ten silhouettes.
import type { MascotAccessory } from "@shared/types";
import type { ShapeAnchors } from "./geometry";
import type { MascotPalette } from "./utils";

type Props = { anchors: ShapeAnchors; palette: MascotPalette };

const GOLD = "#f4c04d";
const GOLD_DARK = "#c8871f";

function Glasses({ anchors, palette }: Props) {
  const cy = anchors.eyeLine;
  const dx = anchors.eyeSpread;
  const sc = anchors.faceScale;
  const r = 7.6 * sc;
  return (
    <g stroke={palette.ink} strokeWidth={2.4 * sc} fill="none" strokeLinecap="round">
      <circle cx={50 - dx} cy={cy} r={r} />
      <circle cx={50 + dx} cy={cy} r={r} />
      <path d={`M${50 - dx + r},${cy} L${50 + dx - r},${cy}`} />
      <path d={`M${50 - dx - r},${cy - 1} L${50 - dx - r - 5},${cy - 3}`} />
      <path d={`M${50 + dx + r},${cy - 1} L${50 + dx + r + 5},${cy - 3}`} />
    </g>
  );
}

function Sunglasses({ anchors, palette }: Props) {
  const cy = anchors.eyeLine;
  const dx = anchors.eyeSpread;
  const sc = anchors.faceScale;
  const r = 8 * sc;
  return (
    <g>
      <g stroke={palette.ink} strokeWidth={2.4 * sc} fill={palette.ink} strokeLinecap="round">
        <circle cx={50 - dx} cy={cy} r={r} />
        <circle cx={50 + dx} cy={cy} r={r} />
        <path d={`M${50 - dx + r},${cy} L${50 + dx - r},${cy}`} fill="none" />
        <path d={`M${50 - dx - r},${cy - 1} L${50 - dx - r - 5},${cy - 3}`} fill="none" />
        <path d={`M${50 + dx + r},${cy - 1} L${50 + dx + r + 5},${cy - 3}`} fill="none" />
      </g>
      {[-1, 1].map((s) => (
        <path
          key={s}
          d={`M${50 + dx * s - 3},${cy - 4} Q${50 + dx * s},${cy - 6} ${50 + dx * s + 3},${cy - 4}`}
          stroke="#fff"
          strokeOpacity={0.55}
          strokeWidth={1.4}
          fill="none"
          strokeLinecap="round"
        />
      ))}
    </g>
  );
}

function Bowtie({ anchors, palette }: Props) {
  const { x, y } = anchors.neck;
  const sc = anchors.faceScale;
  return (
    <g transform={`translate(${x},${y}) scale(${sc})`} fill={palette.ink}>
      <path d="M-9,-5 L-1,0 L-9,5 Z" />
      <path d="M9,-5 L1,0 L9,5 Z" />
      <circle cx={0} cy={0} r={2.3} fill={palette.outline} />
    </g>
  );
}

function Beret({ anchors, palette }: Props) {
  const { x, y } = anchors.headTop;
  const sc = anchors.faceScale;
  return (
    <g transform={`translate(${x + 2},${y - 1}) scale(${sc})`} fill={palette.ink}>
      <path d="M-15,4 C-16,-6 -4,-12 6,-11 C17,-10 18,-1 12,4 C10,-2 2,-6 -4,-5 C-9,-4 -13,0 -15,4 Z" />
      <circle cx={4} cy={-11} r={1.6} />
    </g>
  );
}

function Headphones({ anchors, palette }: Props) {
  const { headTop, earL, earR, faceScale: sc } = anchors;
  return (
    <g>
      <path
        d={`M${earL.x},${earL.y} Q${headTop.x},${headTop.y - 10} ${earR.x},${earR.y}`}
        fill="none"
        stroke={palette.ink}
        strokeWidth={4.2 * sc}
        strokeLinecap="round"
      />
      {[earL, earR].map((p) => (
        <g key={`${p.x}-${p.y}`}>
          <circle cx={p.x} cy={p.y} r={7.6 * sc} fill={palette.ink} />
        </g>
      ))}
    </g>
  );
}

function Cap({ anchors, palette }: Props) {
  const { x, y } = anchors.headTop;
  const w = anchors.crownWidth * 1.15;
  const sc = anchors.faceScale;
  return (
    <g transform={`translate(${x},${y}) scale(${sc})`} fill={palette.ink}>
      <path d={`M${-w / 2},2 C${-w / 2},-10 ${w / 2},-10 ${w / 2},2 Z`} />
      <path d={`M${w / 2 - 2},1 Q${w / 2 + 10},1 ${w / 2 + 11},4 Q${w / 2 + 4},5 ${w / 2 - 3},4 Z`} />
      <circle cx={0} cy={-9} r={1.5} fill={palette.light} />
    </g>
  );
}

function Antenna({ anchors, palette }: Props) {
  const { x, y } = anchors.headTop;
  const sc = anchors.faceScale;
  return (
    <g transform={`translate(${x},${y}) scale(${sc})`}>
      <path d="M0,2 L0,-14" stroke={palette.ink} strokeWidth={2.4} strokeLinecap="round" />
      <circle className="mascot-anim mascot-antenna-tip" cx={0} cy={-16} r={3.2} fill={palette.light} />
    </g>
  );
}

function Crown({ anchors }: Props) {
  const { x, y } = anchors.headTop;
  const w = anchors.crownWidth;
  const sc = anchors.faceScale;
  return (
    <g transform={`translate(${x},${y - 2}) scale(${sc})`}>
      <path
        d={`M${-w / 2},4 L${-w / 2},-4 L${-w / 4},2 L0,-9 L${w / 4},2 L${w / 2},-4 L${w / 2},4 Z`}
        fill={GOLD}
        stroke={GOLD_DARK}
        strokeWidth={1}
        strokeLinejoin="round"
      />
      <circle cx={0} cy={-1.5} r={2} fill={GOLD_DARK} />
    </g>
  );
}

function Scarf({ anchors, palette }: Props) {
  const { x, y } = anchors.neck;
  const sc = anchors.faceScale;
  return (
    <g transform={`translate(${x},${y}) scale(${sc})`}>
      <path d="M-14,-3 Q0,5 14,-3 L14,2 Q0,10 -14,2 Z" fill={palette.ink} />
      <path d="M6,5 Q10,14 7,20 Q4,15 5,7 Z" fill={palette.ink} />
      <path d="M-10,0 Q0,5 10,0" fill="none" stroke={palette.outline} strokeWidth={1} opacity={0.6} />
    </g>
  );
}

export function Accessory({ kind, anchors, palette }: { kind: MascotAccessory } & Props) {
  switch (kind) {
    case "glasses":
      return <Glasses anchors={anchors} palette={palette} />;
    case "sunglasses":
      return <Sunglasses anchors={anchors} palette={palette} />;
    case "bowtie":
      return <Bowtie anchors={anchors} palette={palette} />;
    case "beret":
      return <Beret anchors={anchors} palette={palette} />;
    case "headphones":
      return <Headphones anchors={anchors} palette={palette} />;
    case "cap":
      return <Cap anchors={anchors} palette={palette} />;
    case "antenna":
      return <Antenna anchors={anchors} palette={palette} />;
    case "crown":
      return <Crown anchors={anchors} palette={palette} />;
    case "scarf":
      return <Scarf anchors={anchors} palette={palette} />;
    case "none":
    default:
      return null;
  }
}
