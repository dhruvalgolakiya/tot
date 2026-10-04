// The ten accessories, as flat paper cut-outs. They're drawn in `currentColor`, which
// styles.ts sets per theme: near-black on light backgrounds, off-white on dark ones,
// so a hat sticking out past the body never disappears into the canvas. Small details
// (buttons, pads, the antenna tip) use the mascot's own color; the sunglasses stay black.
// Positioned using each shape's anchor points so the same accessory code works across
// all ten silhouettes.
import type { MascotAccessory } from "@shared/types";
import type { ShapeAnchors } from "./geometry";
import type { MascotPalette } from "./utils";

type Props = { anchors: ShapeAnchors; palette: MascotPalette };

const CUT = "currentColor";

function Glasses({ anchors }: Props) {
  const cy = anchors.eyeLine;
  const dx = anchors.eyeSpread;
  const sc = anchors.faceScale;
  const r = 10.4 * sc;
  return (
    <g stroke={CUT} strokeWidth={2.8 * sc} fill="none" strokeLinecap="round">
      <circle cx={50 - dx} cy={cy} r={r} />
      <circle cx={50 + dx} cy={cy} r={r} />
      <path d={`M${50 - dx + r},${cy - 1} Q50,${cy - 4} ${50 + dx - r},${cy - 1}`} />
    </g>
  );
}

function Sunglasses({ anchors, palette }: Props) {
  const cy = anchors.eyeLine;
  const dx = anchors.eyeSpread;
  const sc = anchors.faceScale;
  const w = 21 * sc;
  const h = 14 * sc;
  return (
    <g fill={palette.ink}>
      <rect x={50 - dx - w / 2} y={cy - h / 2} width={w} height={h} rx={6 * sc} />
      <rect x={50 + dx - w / 2} y={cy - h / 2} width={w} height={h} rx={6 * sc} />
      <rect x={50 - dx + w / 2 - 1} y={cy - h / 2 + 1} width={2 * dx - w + 2} height={3 * sc} />
      {[-1, 1].map((s) => (
        <path
          key={s}
          d={`M${50 + dx * s - 6 * sc},${cy + 2 * sc} L${50 + dx * s - 1 * sc},${cy - 4 * sc}`}
          stroke={palette.paper}
          strokeOpacity={0.55}
          strokeWidth={2.2 * sc}
          strokeLinecap="round"
        />
      ))}
    </g>
  );
}

function Bowtie({ anchors, palette }: Props) {
  const { x, y } = anchors.neck;
  return (
    <g>
      <path
        d={`M${x},${y} L${x - 12},${y - 7} Q${x - 14},${y} ${x - 12},${y + 7} Z M${x},${y} L${x + 12},${y - 7} Q${x + 14},${y} ${x + 12},${y + 7} Z`}
        fill={CUT}
      />
      <rect x={x - 3.2} y={y - 4} width={6.4} height={8} rx={2} fill={palette.base} stroke={CUT} strokeWidth={1.6} />
    </g>
  );
}

function Beret({ anchors }: Props) {
  const { x, y } = anchors.headTop;
  const w = Math.max(anchors.crownWidth, 22) + 14;
  return (
    <g fill={CUT}>
      <path
        d={`M${x - w / 2},${y + 2} C${x - w / 2},${y - 9} ${x + w / 2 - 2},${y - 13} ${x + w / 2 + 3},${y - 3} C${x + w / 2 + 4},${y + 3} ${x + w / 4},${y + 4} ${x},${y + 4} C${x - w / 4},${y + 4} ${x - w / 2},${y + 5} ${x - w / 2},${y + 2} Z`}
      />
      <circle cx={x + 2} cy={y - 10} r={2.6} />
    </g>
  );
}

function Headphones({ anchors, palette }: Props) {
  const { headTop, earL, earR } = anchors;
  const top = headTop.y - 6;
  return (
    <g>
      <path
        d={`M${earL.x + 2},${earL.y - 4} C${earL.x + 2},${top} ${earR.x - 2},${top} ${earR.x - 2},${earR.y - 4}`}
        fill="none"
        stroke={CUT}
        strokeWidth={5}
        strokeLinecap="round"
      />
      {[earL, earR].map((ear, i) => (
        <g key={i}>
          <rect x={ear.x - 6} y={ear.y - 12} width={12} height={24} rx={5} fill={CUT} />
          <rect x={ear.x + (i === 0 ? 1.6 : -4.6)} y={ear.y - 7} width={3} height={14} rx={1.5} fill={palette.base} />
        </g>
      ))}
    </g>
  );
}

function Cap({ anchors, palette }: Props) {
  const { x, y } = anchors.headTop;
  const w = Math.max(anchors.crownWidth, 20) + 10;
  return (
    <g fill={CUT}>
      <path d={`M${x - w / 2},${y + 4} A${w / 2},${w / 2.4} 0 0 1 ${x + w / 2},${y + 4} Z`} />
      <rect x={x + w / 2 - 6} y={y + 1} width={16} height={4.5} rx={2.25} />
      <circle cx={x} cy={y + 4 - w / 2.4} r={2.4} fill={palette.base} stroke={CUT} strokeWidth={1.6} />
    </g>
  );
}

function Antenna({ anchors, palette }: Props) {
  const { x, y } = anchors.headTop;
  return (
    <g>
      <rect x={x - 1.6} y={y - 13} width={3.2} height={14} rx={1.6} fill={CUT} />
      <circle className="mascot-antenna-tip" cx={x} cy={y - 15} r={5} fill={palette.base} stroke={CUT} strokeWidth={2} />
    </g>
  );
}

function Crown({ anchors, palette }: Props) {
  const { x, y } = anchors.headTop;
  const w = Math.max(anchors.crownWidth, 18) + 4;
  const h = w * 0.62;
  const b = y + 3;
  return (
    <g>
      <path
        d={`M${x - w / 2},${b} L${x - w / 2},${b - h} L${x - w / 4},${b - h * 0.55} L${x},${b - h * 1.05} L${x + w / 4},${b - h * 0.55} L${x + w / 2},${b - h} L${x + w / 2},${b} Z`}
        fill={CUT}
        strokeLinejoin="round"
      />
      <circle cx={x} cy={b - h * 0.32} r={2.2} fill={palette.base} />
    </g>
  );
}

function Scarf({ anchors, palette }: Props) {
  const { x, y } = anchors.neck;
  return (
    <g>
      <rect x={x + 6} y={y - 2} width={9} height={20} rx={3} transform={`rotate(-12 ${x + 10} ${y})`} fill={CUT} />
      <rect x={x - 25} y={y - 6} width={50} height={11} rx={5.5} fill={CUT} />
      <rect x={x - 12} y={y - 6} width={4} height={11} fill={palette.base} />
      <rect x={x + 4} y={y - 6} width={4} height={11} fill={palette.base} />
    </g>
  );
}

export function Accessory({ kind, anchors, palette }: { kind: MascotAccessory } & Props) {
  const props = { anchors, palette };
  const piece = (() => {
    switch (kind) {
      case "glasses":
        return <Glasses {...props} />;
      case "sunglasses":
        return <Sunglasses {...props} />;
      case "bowtie":
        return <Bowtie {...props} />;
      case "beret":
        return <Beret {...props} />;
      case "headphones":
        return <Headphones {...props} />;
      case "cap":
        return <Cap {...props} />;
      case "antenna":
        return <Antenna {...props} />;
      case "crown":
        return <Crown {...props} />;
      case "scarf":
        return <Scarf {...props} />;
      default:
        return null;
    }
  })();
  return piece && <g className="mascot-cutout">{piece}</g>;
}
