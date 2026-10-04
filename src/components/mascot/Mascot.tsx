// The mascot itself: one <svg>, built from a shape silhouette (geometry.ts), a flat
// cut-paper palette (utils.ts), a face (Faces.tsx) and an optional accessory
// (Accessories.tsx). Cut-paper style: one flat body color with a single diagonal
// "fold" of shadow, no gloss and no outline. All motion is CSS (styles.ts) driven by
// the `state` class and a handful of per-instance custom properties that desync many
// on-screen mascots from each other without any JS timers.
import { useId, useMemo, type CSSProperties } from "react";
import clsx from "clsx";
import type { MascotState, MascotSpec } from "@shared/types";
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

function BodyShape({ piece, fill, className }: { piece: BodyPiece; fill: string; className?: string }) {
  if ("d" in piece) return <path d={piece.d} fill={fill} className={className} />;
  return <circle cx={piece.cx} cy={piece.cy} r={piece.r} fill={fill} className={className} />;
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

  const clipId = `mascot-clip-${rawId}`;
  const silhouette = [...(shapeDef.back ?? []), ...shapeDef.body];
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
        <clipPath id={clipId}>
          {silhouette.map((piece, i) => (
            <BodyShape key={i} piece={piece} fill="#000" />
          ))}
        </clipPath>
      </defs>

      <g className="mascot-anim mascot-body-anim">
        {silhouette.map((piece, i) => (
          <BodyShape key={i} piece={piece} fill={palette.base} />
        ))}
        {/* The fold: the lower-right half of the paper, a shade darker. */}
        <path d="M108,0 L108,108 L0,108 Z" fill={palette.fold} clipPath={`url(#${clipId})`} />
        {detailed &&
          shapeDef.ink?.map((piece, i) => <BodyShape key={`ink-${i}`} piece={piece} fill="currentColor" className="mascot-cutout" />)}

        <Eyes eyeStyle={spec.eyes} anchors={shapeDef.anchors} palette={palette} state={state} />
        {state === "error" && <Brows anchors={shapeDef.anchors} palette={palette} />}
        <Mouth state={state} anchors={shapeDef.anchors} palette={palette} />

        {detailed && spec.accessory !== "none" && <Accessory kind={spec.accessory} anchors={shapeDef.anchors} palette={palette} />}

        {state === "thinking" && <ThinkDots x={headTop.x} y={headTop.y - 13} color={palette.base} />}
        {state === "working" && <Glint x={headTop.x + crownWidth / 2 + 7} y={headTop.y - 3} color={palette.base} />}
        {state === "sleeping" && <SleepZs x={headTop.x + crownWidth / 2 - 4} y={headTop.y - 4} color={palette.base} />}
      </g>
    </svg>
  );
}
