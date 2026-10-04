// Eyes, mouth, brows, and the small state-only decorations (thinking dots, working
// glint, sleeping z's). Kept separate from Mascot.tsx because this is where most of
// the "personality" tuning happens. Cut-paper style: white eyes with a black pupil
// that looks around, flat black mouths, no gloss.
import type { MascotEyes, MascotState } from "@shared/types";
import type { ShapeAnchors } from "./geometry";
import type { MascotPalette } from "./utils";

/** One eye at the origin. The pupil sits in its own group so CSS can move it (gaze) without moving the eye. */
function EyeShape({ eyeStyle, palette }: { eyeStyle: MascotEyes; palette: MascotPalette }) {
  switch (eyeStyle) {
    case "happy":
      return <path d="M-7,2.5 Q0,-8 7,2.5" fill="none" stroke={palette.ink} strokeWidth={4.6} strokeLinecap="round" />;
    case "wide":
      return (
        <>
          <circle r={9.6} fill={palette.paper} />
          <g className="mascot-anim mascot-pupil">
            <circle cx={1} cy={0.6} r={4.2} fill={palette.ink} />
          </g>
        </>
      );
    case "sleepy":
      // Half-closed: the lower half of the eye, a lid line, and the pupil peeking out.
      return (
        <>
          <path d="M-8.4,-0.6 A8.4,8.4 0 0 0 8.4,-0.6 Z" fill={palette.paper} />
          <g className="mascot-anim mascot-pupil">
            <circle cx={1.6} cy={2.6} r={3.9} fill={palette.ink} />
          </g>
          <rect x={-9.4} y={-2.4} width={18.8} height={3.6} rx={1.8} fill={palette.ink} />
        </>
      );
    case "dots":
    default:
      return (
        <>
          <circle r={8.4} fill={palette.paper} />
          <g className="mascot-anim mascot-pupil">
            <circle cx={1.8} cy={0.8} r={4.6} fill={palette.ink} />
          </g>
        </>
      );
  }
}

export function Eyes({
  eyeStyle,
  anchors,
  palette,
  state,
}: {
  eyeStyle: MascotEyes;
  anchors: ShapeAnchors;
  palette: MascotPalette;
  state: MascotState;
}) {
  const cx = 50;
  const cy = anchors.eyeLine;
  const dx = anchors.eyeSpread;
  const sc = anchors.faceScale;

  // Sleeping always shows closed lids, and a happy mascot always squints, whatever the eye style.
  if (state === "sleeping" || state === "happy") {
    const d = state === "sleeping" ? "M-6.5,-0.5 Q0,4.5 6.5,-0.5" : "M-7,2.5 Q0,-8 7,2.5";
    return (
      <g>
        {[-1, 1].map((s) => (
          <path
            key={s}
            d={d}
            transform={`translate(${cx + dx * s},${cy}) scale(${sc})`}
            fill="none"
            stroke={palette.ink}
            strokeWidth={4.4}
            strokeLinecap="round"
          />
        ))}
      </g>
    );
  }

  return (
    <g className="mascot-anim mascot-eyes-wrap">
      {[-1, 1].map((s) => (
        // IMPORTANT: the CSS `transform` property (used below for blink/gaze animation)
        // completely replaces an SVG `transform` attribute on the same element rather
        // than composing with it — so the positioning attribute must live on its own,
        // never-animated wrapper `<g>`, with the animated class one level further in.
        <g key={s} transform={`translate(${cx + dx * s},${cy}) scale(${sc})`}>
          <g className="mascot-anim mascot-eyes-blink">
            <EyeShape eyeStyle={eyeStyle} palette={palette} />
          </g>
        </g>
      ))}
    </g>
  );
}

/** Cross brows, for "error". */
export function Brows({ anchors, palette }: { anchors: ShapeAnchors; palette: MascotPalette }) {
  const sc = anchors.faceScale;
  const y = anchors.eyeLine - 12 * sc;
  const dx = anchors.eyeSpread;
  return (
    <g fill={palette.ink}>
      <rect x={-6} y={-1.6} width={12} height={3.2} rx={1.6} transform={`translate(${50 - dx},${y}) rotate(14) scale(${sc})`} />
      <rect x={-6} y={-1.6} width={12} height={3.2} rx={1.6} transform={`translate(${50 + dx},${y}) rotate(-14) scale(${sc})`} />
    </g>
  );
}

/** An open half-moon smile with a tongue: the default face, bigger when happy. */
function Smile({ r, palette }: { r: number; palette: MascotPalette }) {
  return (
    <>
      <path d={`M${-r},0 A${r},${r} 0 0 0 ${r},0 Z`} fill={palette.ink} />
      <path d={`M${-r * 0.5},${r * 0.66} A${r * 0.52},${r * 0.42} 0 0 1 ${r * 0.5},${r * 0.66} Z`} fill={palette.tongue} />
    </>
  );
}

export function Mouth({ state, anchors, palette }: { state: MascotState; anchors: ShapeAnchors; palette: MascotPalette }) {
  const cx = 50;
  const cy = anchors.mouthY;
  const sc = anchors.faceScale;
  const t = `translate(${cx},${cy}) scale(${sc})`;

  if (state === "sleeping") return <ellipse transform={t} cx={0} cy={1} rx={2.6} ry={3} fill={palette.ink} />;

  if (state === "happy")
    return (
      <g transform={t}>
        <Smile r={10.5} palette={palette} />
      </g>
    );

  if (state === "speaking")
    // IMPORTANT: `mascot-talk` animates CSS `transform` (scaleY), which would replace
    // an SVG `transform` attribute on the same element outright — so positioning goes
    // on an outer, never-animated `<g>`, and the animated ellipse sits at its origin.
    return (
      <g transform={t}>
        <ellipse className="mascot-anim mascot-mouth-anim" cx={0} cy={2} rx={6.4} ry={6.2} fill={palette.ink} />
      </g>
    );

  if (state === "error")
    return (
      <path
        transform={t}
        d="M-7.5,2 L-3.75,-1.5 L0,2 L3.75,-1.5 L7.5,2"
        fill="none"
        stroke={palette.ink}
        strokeWidth={3.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    );

  if (state === "working") return <rect transform={t} x={-6} y={-1.8} width={12} height={3.6} rx={1.8} fill={palette.ink} />;

  if (state === "thinking") return <ellipse transform={t} cx={3} cy={0.6} rx={3.4} ry={3.8} fill={palette.ink} />;

  // idle
  return (
    <g transform={t}>
      <Smile r={7.8} palette={palette} />
    </g>
  );
}

/** Three small dots popping above the head — "thinking". */
export function ThinkDots({ x, y, color }: { x: number; y: number; color: string }) {
  return (
    <g>
      {[-8, 0, 8].map((dx, i) => (
        <circle key={dx} className="mascot-anim mascot-think-dot" cx={x + dx} cy={y - (i === 1 ? 3.5 : 0)} r={3.1} fill={color} />
      ))}
    </g>
  );
}

/** A small four-point sparkle near the head — "working". */
export function Glint({ x, y, color }: { x: number; y: number; color: string }) {
  // IMPORTANT: same rule as the eyes/mouth above — `mascot-glint` animates CSS
  // `transform` (scale), so positioning must live on an outer, unanimated `<g>`.
  return (
    <g transform={`translate(${x},${y})`}>
      <path className="mascot-anim mascot-glint" d="M0,-6.5 L1.7,-1.7 L6.5,0 L1.7,1.7 L0,6.5 L-1.7,1.7 L-6.5,0 L-1.7,-1.7 Z" fill={color} />
    </g>
  );
}

/** Floating "z"s above the head — "sleeping". */
export function SleepZs({ x, y, color }: { x: number; y: number; color: string }) {
  return (
    <g fill={color} fontWeight={700} style={{ fontFamily: "inherit" }}>
      <text className="mascot-anim mascot-z" x={x} y={y} fontSize={9}>
        z
      </text>
      <text className="mascot-anim mascot-z" x={x + 7} y={y - 8} fontSize={12}>
        z
      </text>
    </g>
  );
}
