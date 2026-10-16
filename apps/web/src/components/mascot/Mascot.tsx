// The mascot itself: one <svg>, built from a shape silhouette (geometry.ts), a
// derived shading palette (utils.ts), a face (Faces.tsx) and an optional accessory
// (Accessories.tsx). All motion is CSS (styles.ts) driven by the `state` class and a
// handful of per-instance custom properties that desync many on-screen mascots from
// each other without any JS timers.
import { useId, useMemo, type CSSProperties } from "react";
import clsx from "clsx";
import type { MascotState, MascotSpec } from "@tot/shared/types";
import { mascotLabel } from "./catalog";
import { Accessory } from "./Accessories";
import { Brows, Eyes, Glint, Mouth, SleepZs, ThinkDots } from "./Faces";
import { SHAPES, type BodyPiece } from "./geometry";
import { ensureMascotStyles } from "./styles";
import { derivePalette, hashFloat, specKey } from "./utils";

export interface MascotProps {
  spec: MascotSpec;
  state?: MascotState;
  /** Rendered width/height in px (viewBox is always 100x100, so it scales cleanly). */
  size?: number;
  className?: string;
  /** Optional tooltip/accessible name override; defaults to a generated description. */
  title?: string;
}

function BodyShape({ piece, fill }: { piece: BodyPiece; fill: string }) {
  if ("d" in piece) return <path d={piece.d} fill={fill} />;
  return <circle cx={piece.cx} cy={piece.cy} r={piece.r} fill={fill} />;
}

export function Mascot({ spec, state = "idle", size = 64, className, title }: MascotProps) {
  ensureMascotStyles();

  const rawId = useId().replace(/[^\w-]/g, "");
  const shapeDef = SHAPES[spec.shape];
  const palette = useMemo(() => derivePalette(spec.color), [spec.color]);
  const key = useMemo(() => specKey(spec), [spec]);
  const detailed = size >= 24;

  const vars = useMemo<Record<string, string>>(
    () => ({
      "--m-breathe": `${(hashFloat(key, "breathe") * 6).toFixed(2)}s`,
      "--m-blink": `${(hashFloat(key, "blink") * 6).toFixed(2)}s`,
      "--m-gaze": `${(hashFloat(key, "gaze") * 8).toFixed(2)}s`,
      "--m-think": `${(hashFloat(key, "think") * 2).toFixed(2)}s`,
      "--m-glint": `${(hashFloat(key, "glint") * 3).toFixed(2)}s`,
      "--m-z": `${(hashFloat(key, "z") * 3).toFixed(2)}s`,
    }),
    [key],
  );

  const bodyGradId = `mascot-body-${rawId}`;
  const shineGradId = `mascot-shine-${rawId}`;
  const { headTop, crownWidth } = shapeDef.anchors;
  const label = title ?? mascotLabel(spec);

  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={clsx("mascot", `mascot--${state}`, className)}
      style={vars as unknown as CSSProperties}
      role="img"
      aria-label={label}
    >
      {title ? <title>{title}</title> : null}
      <defs>
        <linearGradient id={bodyGradId} x1="12%" y1="6%" x2="90%" y2="98%">
          <stop offset="0%" stopColor={palette.light} />
          <stop offset="55%" stopColor={palette.base} />
          <stop offset="100%" stopColor={palette.dark} />
        </linearGradient>
        <radialGradient id={shineGradId} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.85" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
      </defs>

      <g className="mascot-anim mascot-body-anim">
        {shapeDef.back?.map((piece, i) => (
          <BodyShape key={`back-${i}`} piece={piece} fill={`url(#${bodyGradId})`} />
        ))}
        {shapeDef.body.map((piece, i) => (
          <BodyShape key={`body-${i}`} piece={piece} fill={`url(#${bodyGradId})`} />
        ))}
        {detailed &&
          shapeDef.ink?.map((piece, i) => (
            <BodyShape key={`ink-${i}`} piece={piece} fill={palette.ink} />
          ))}

        <ellipse
          cx={shapeDef.highlight.cx}
          cy={shapeDef.highlight.cy}
          rx={shapeDef.highlight.rx}
          ry={shapeDef.highlight.ry}
          fill={`url(#${shineGradId})`}
          opacity={0.38}
          transform={
            shapeDef.highlight.rotate
              ? `rotate(${shapeDef.highlight.rotate} ${shapeDef.highlight.cx} ${shapeDef.highlight.cy})`
              : undefined
          }
        />

        <Eyes eyeStyle={spec.eyes} anchors={shapeDef.anchors} palette={palette} state={state} />
        {state === "error" && <Brows anchors={shapeDef.anchors} palette={palette} />}
        <Mouth state={state} anchors={shapeDef.anchors} palette={palette} />

        {detailed && spec.accessory !== "none" && (
          <Accessory kind={spec.accessory} anchors={shapeDef.anchors} palette={palette} />
        )}

        {state === "thinking" && <ThinkDots x={headTop.x} y={headTop.y - 13} color={palette.base} />}
        {state === "working" && <Glint x={headTop.x + crownWidth / 2 + 6} y={headTop.y - 2} />}
        {state === "sleeping" && <SleepZs x={headTop.x + crownWidth / 2 - 4} y={headTop.y - 4} color={palette.outline} />}
      </g>
    </svg>
  );
}
