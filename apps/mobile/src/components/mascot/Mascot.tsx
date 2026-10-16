// The agent's mascot, drawn like apps/web/src/components/mascot/Mascot.tsx (shape, color, eyes, accessory)
// with react-native-svg. Still, not animated: on a phone mascots sit in lists, and dozens of looping animations
// would cost battery for little. The face follows the web's idle look; a sleeping one (an offline device) closes
// its eyes.
import { memo, useId, useMemo } from "react";
import { View } from "react-native";
import Svg, { Circle, Defs, Ellipse, G, LinearGradient, Path, RadialGradient, Rect, Stop } from "react-native-svg";
import type { MascotAccessory, MascotEyes, MascotSpec } from "@tot/shared/types";
import { MASCOT_ACCESSORIES, MASCOT_EYES, MASCOT_SHAPES } from "../../lib/agents";
import { type BodyPiece, SHAPES, type ShapeAnchors } from "./geometry";
import { derivePalette, type MascotPalette } from "./palette";

type Props = { anchors: ShapeAnchors; palette: MascotPalette };

function Body({ piece, fill }: { piece: BodyPiece; fill: string }) {
  if ("d" in piece) return <Path d={piece.d} fill={fill} />;
  return <Circle cx={piece.cx} cy={piece.cy} r={piece.r} fill={fill} />;
}

function EyeShape({ eyes, ink }: { eyes: MascotEyes; ink: string }) {
  switch (eyes) {
    case "happy":
      return <Path d="M-7.5,2.5 Q0,-9.2 7.5,2.5" fill="none" stroke={ink} strokeWidth={5} strokeLinecap="round" />;
    case "wide":
      return (
        <G>
          <Circle cx={0} cy={0} r={9.6} fill="#fff" />
          <Circle cx={1.4} cy={0.8} r={4.8} fill={ink} />
        </G>
      );
    case "sleepy":
      return <Path d="M-7,-1.5 Q0,6.5 7,-1.5" fill="none" stroke={ink} strokeWidth={4.6} strokeLinecap="round" />;
    case "dots":
    default:
      return <Rect x={-4.4} y={-8} width={8.8} height={16} rx={4.4} fill={ink} />;
  }
}

function Eyes({ eyes, anchors, palette, sleeping }: { eyes: MascotEyes; sleeping: boolean } & Props) {
  const { eyeLine: cy, eyeSpread: dx, faceScale: sc } = anchors;
  return (
    <G>
      {[-1, 1].map((s) => (
        <G key={s} transform={`translate(${50 + dx * s},${cy}) scale(${sc})`}>
          {sleeping ? (
            <Path d="M-6,0 Q0,3.6 6,0" fill="none" stroke={palette.ink} strokeWidth={3.6} strokeLinecap="round" />
          ) : (
            <EyeShape eyes={eyes} ink={palette.ink} />
          )}
        </G>
      ))}
    </G>
  );
}

const GOLD = "#f4c04d";
const GOLD_DARK = "#c8871f";

function Accessory({ kind, anchors, palette }: { kind: MascotAccessory } & Props) {
  const { headTop, neck, earL, earR, eyeLine: cy, eyeSpread: dx, faceScale: sc, crownWidth } = anchors;
  switch (kind) {
    case "glasses":
    case "sunglasses": {
      const dark = kind === "sunglasses";
      const r = (dark ? 8 : 7.6) * sc;
      return (
        <G>
          <G stroke={palette.ink} strokeWidth={2.4 * sc} strokeLinecap="round">
            <Circle cx={50 - dx} cy={cy} r={r} fill={dark ? palette.ink : "none"} />
            <Circle cx={50 + dx} cy={cy} r={r} fill={dark ? palette.ink : "none"} />
            <Path d={`M${50 - dx + r},${cy} L${50 + dx - r},${cy}`} fill="none" />
            <Path d={`M${50 - dx - r},${cy - 1} L${50 - dx - r - 5},${cy - 3}`} fill="none" />
            <Path d={`M${50 + dx + r},${cy - 1} L${50 + dx + r + 5},${cy - 3}`} fill="none" />
          </G>
          {dark
            ? [-1, 1].map((s) => (
                <Path
                  key={s}
                  d={`M${50 + dx * s - 3},${cy - 4} Q${50 + dx * s},${cy - 6} ${50 + dx * s + 3},${cy - 4}`}
                  stroke="#fff"
                  strokeOpacity={0.55}
                  strokeWidth={1.4}
                  fill="none"
                  strokeLinecap="round"
                />
              ))
            : null}
        </G>
      );
    }
    case "bowtie":
      return (
        <G transform={`translate(${neck.x},${neck.y}) scale(${sc})`} fill={palette.ink}>
          <Path d="M-9,-5 L-1,0 L-9,5 Z" />
          <Path d="M9,-5 L1,0 L9,5 Z" />
          <Circle cx={0} cy={0} r={2.3} fill={palette.outline} />
        </G>
      );
    case "beret":
      return (
        <G transform={`translate(${headTop.x + 2},${headTop.y - 1}) scale(${sc})`} fill={palette.ink}>
          <Path d="M-15,4 C-16,-6 -4,-12 6,-11 C17,-10 18,-1 12,4 C10,-2 2,-6 -4,-5 C-9,-4 -13,0 -15,4 Z" />
          <Circle cx={4} cy={-11} r={1.6} />
        </G>
      );
    case "headphones":
      return (
        <G>
          <Path d={`M${earL.x},${earL.y} Q${headTop.x},${headTop.y - 10} ${earR.x},${earR.y}`} fill="none" stroke={palette.ink} strokeWidth={4.2 * sc} strokeLinecap="round" />
          <Circle cx={earL.x} cy={earL.y} r={7.6 * sc} fill={palette.ink} />
          <Circle cx={earR.x} cy={earR.y} r={7.6 * sc} fill={palette.ink} />
        </G>
      );
    case "cap": {
      const w = crownWidth * 1.15;
      return (
        <G transform={`translate(${headTop.x},${headTop.y}) scale(${sc})`} fill={palette.ink}>
          <Path d={`M${-w / 2},2 C${-w / 2},-10 ${w / 2},-10 ${w / 2},2 Z`} />
          <Path d={`M${w / 2 - 2},1 Q${w / 2 + 10},1 ${w / 2 + 11},4 Q${w / 2 + 4},5 ${w / 2 - 3},4 Z`} />
          <Circle cx={0} cy={-9} r={1.5} fill={palette.light} />
        </G>
      );
    }
    case "antenna":
      return (
        <G transform={`translate(${headTop.x},${headTop.y}) scale(${sc})`}>
          <Path d="M0,2 L0,-14" stroke={palette.ink} strokeWidth={2.4} strokeLinecap="round" />
          <Circle cx={0} cy={-16} r={3.2} fill={palette.light} />
        </G>
      );
    case "crown": {
      const w = crownWidth;
      return (
        <G transform={`translate(${headTop.x},${headTop.y - 2}) scale(${sc})`}>
          <Path d={`M${-w / 2},4 L${-w / 2},-4 L${-w / 4},2 L0,-9 L${w / 4},2 L${w / 2},-4 L${w / 2},4 Z`} fill={GOLD} stroke={GOLD_DARK} strokeWidth={1} strokeLinejoin="round" />
          <Circle cx={0} cy={-1.5} r={2} fill={GOLD_DARK} />
        </G>
      );
    }
    case "scarf":
      return (
        <G transform={`translate(${neck.x},${neck.y}) scale(${sc})`}>
          <Path d="M-14,-3 Q0,5 14,-3 L14,2 Q0,10 -14,2 Z" fill={palette.ink} />
          <Path d="M6,5 Q10,14 7,20 Q4,15 5,7 Z" fill={palette.ink} />
          <Path d="M-10,0 Q0,5 10,0" fill="none" stroke={palette.outline} strokeWidth={1} opacity={0.6} />
        </G>
      );
    case "none":
    default:
      return null;
  }
}

/** "Blob with glasses", for the screen reader, like the web's mascotLabel. */
export function mascotLabel(spec: MascotSpec): string {
  const shape = MASCOT_SHAPES[spec.shape] ?? spec.shape;
  if (spec.accessory === "none") return `${shape} mascot, ${(MASCOT_EYES[spec.eyes] ?? spec.eyes).toLowerCase()} eyes`;
  return `${shape} mascot with ${(MASCOT_ACCESSORIES[spec.accessory] ?? spec.accessory).toLowerCase()}`;
}

/**
 * The mascot at `size` points. It's decorative next to the agent's name (VoiceOver reads the name), unless `describe`
 * (a mascot editor) has it read out as "Cat mascot with sunglasses". Below 24 pt (as on the web) the small ink details and the accessory are left out so
 * the silhouette and eyes stay crisp; the eyes alone still tell agents apart in a dense list.
 */
export const Mascot = memo(function Mascot({
  mascot,
  size = 36,
  faded = false,
  sleeping = false,
  describe = false,
}: {
  mascot: MascotSpec;
  size?: number;
  faded?: boolean;
  sleeping?: boolean;
  describe?: boolean;
}) {
  const id = useId().replace(/[^\w-]/g, "");
  const shape = SHAPES[mascot.shape] ?? SHAPES.blob;
  const palette = useMemo(() => derivePalette(mascot.color), [mascot.color]);
  const detailed = size >= 24;
  const body = `body-${id}`;
  const shine = `shine-${id}`;
  const h = shape.highlight;
  return (
    <View
      accessible={describe}
      accessibilityRole={describe ? "image" : undefined}
      accessibilityLabel={describe ? mascotLabel(mascot) : undefined}
      accessibilityElementsHidden={!describe}
      importantForAccessibility={describe ? "auto" : "no-hide-descendants"}
      style={{ width: size, height: size, opacity: faded ? 0.45 : 1 }}
    >
      <Svg width={size} height={size} viewBox="0 0 100 100">
        <Defs>
          <LinearGradient id={body} x1="0.12" y1="0.06" x2="0.9" y2="0.98">
            <Stop offset="0" stopColor={palette.light} />
            <Stop offset="0.55" stopColor={palette.base} />
            <Stop offset="1" stopColor={palette.dark} />
          </LinearGradient>
          <RadialGradient id={shine} cx="50%" cy="50%" r="50%">
            <Stop offset="0" stopColor="#ffffff" stopOpacity={0.85} />
            <Stop offset="1" stopColor="#ffffff" stopOpacity={0} />
          </RadialGradient>
        </Defs>
        {shape.back?.map((piece, i) => <Body key={`back-${i}`} piece={piece} fill={`url(#${body})`} />)}
        {shape.body.map((piece, i) => <Body key={`body-${i}`} piece={piece} fill={`url(#${body})`} />)}
        {detailed && shape.ink?.map((piece, i) => <Body key={`ink-${i}`} piece={piece} fill={palette.ink} />)}
        <Ellipse
          cx={h.cx}
          cy={h.cy}
          rx={h.rx}
          ry={h.ry}
          fill={`url(#${shine})`}
          opacity={0.38}
          transform={h.rotate ? `rotate(${h.rotate} ${h.cx} ${h.cy})` : undefined}
        />
        <Eyes eyes={mascot.eyes} anchors={shape.anchors} palette={palette} sleeping={sleeping} />
        {detailed && mascot.accessory !== "none" ? <Accessory kind={mascot.accessory} anchors={shape.anchors} palette={palette} /> : null}
      </Svg>
    </View>
  );
});
