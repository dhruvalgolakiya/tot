// Eyes, mouth, brows, and the small state-only decorations (thinking dots, working
// glint, sleeping z's). Kept separate from Mascot.tsx because this is where most of
// the "personality" tuning happens.
import type { MascotEyes, MascotState } from "@shared/types";
import type { ShapeAnchors } from "./geometry";
import type { MascotPalette } from "./utils";

function EyeShape({ eyeStyle, ink }: { eyeStyle: MascotEyes; ink: string }) {
  switch (eyeStyle) {
    case "happy":
      return <path d="M-7.5,2.5 Q0,-9.2 7.5,2.5" fill="none" stroke={ink} strokeWidth={5} strokeLinecap="round" />;
    case "wide":
      // Googly: a white eye with a black pupil.
      return (
        <>
          <circle cx={0} cy={0} r={9.6} fill="#fff" />
          <circle cx={1.4} cy={0.8} r={4.8} fill={ink} />
        </>
      );
    case "sleepy":
      // Content, eyes closed.
      return <path d="M-7,-1.5 Q0,6.5 7,-1.5" fill="none" stroke={ink} strokeWidth={4.6} strokeLinecap="round" />;
    case "dots":
    default:
      // Two plain capsules: no glints, no lashes.
      return <rect x={-4.4} y={-8} width={8.8} height={16} rx={4.4} fill={ink} />;
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

  // Sleeping always shows closed lids, regardless of the mascot's chosen eye style; a happy mascot
  // always squints (with no mouth, the eyes carry the expression).
  if (state === "happy") {
    return (
      <g>
        {[-1, 1].map((s) => (
          <g key={s} transform={`translate(${cx + dx * s},${cy}) scale(${sc})`}>
            <EyeShape eyeStyle="happy" ink={palette.ink} />
          </g>
        ))}
      </g>
    );
  }
  if (state === "sleeping") {
    return (
      <g>
        {[-1, 1].map((s) => (
          <path
            key={s}
            d="M-6,0 Q0,3.6 6,0"
            transform={`translate(${cx + dx * s},${cy}) scale(${sc})`}
            fill="none"
            stroke={palette.ink}
            strokeWidth={3.6}
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
            <EyeShape eyeStyle={eyeStyle} ink={palette.ink} />
          </g>
        </g>
      ))}
    </g>
  );
}

export function Brows({ anchors, palette }: { anchors: ShapeAnchors; palette: MascotPalette }) {
  const y = anchors.eyeLine - 9 * anchors.faceScale;
  const dx = anchors.eyeSpread;
  return (
    <g stroke={palette.ink} strokeWidth={2.6} strokeLinecap="round" fill="none">
      <path d={`M${50 - dx - 5},${y + 3} L${50 - dx + 5},${y - 2}`} />
      <path d={`M${50 + dx + 5},${y + 3} L${50 + dx - 5},${y - 2}`} />
    </g>
  );
}

export function Mouth({
  state,
  anchors,
  palette,
}: {
  state: MascotState;
  anchors: ShapeAnchors;
  palette: MascotPalette;
}) {
  const cx = 50;
  const cy = anchors.mouthY;
  const sc = anchors.faceScale;
  const t = `translate(${cx},${cy}) scale(${sc})`;

  if (state === "sleeping") return null; // closed eyes + z's already say it all

  if (state === "speaking")
    // IMPORTANT: `mascot-talk` animates CSS `transform` (scaleY), which would replace
    // an SVG `transform` attribute on the same element outright — so positioning goes
    // on an outer, never-animated `<g>`, and the animated ellipse sits at its origin.
    return (
      <g transform={t}>
        <ellipse className="mascot-anim mascot-mouth-anim" cx={0} cy={1} rx={6} ry={6.4} fill={palette.ink} />
      </g>
    );

  if (state === "error")
    return (
      <path
        transform={t}
        d="M-7,1.2 Q-3.5,-2 0,0.6 Q3.5,-2 7,1.2"
        fill="none"
        stroke={palette.ink}
        strokeWidth={3.6}
        strokeLinecap="round"
      />
    );

  // Like Dots and Grok Bot, the face is just the eyes; a mouth only shows while talking (or upset).
  return null;
}

/** Three small dots pulsing above the head — "thinking". */
export function ThinkDots({ x, y, color }: { x: number; y: number; color: string }) {
  return (
    <g>
      {[-8, 0, 8].map((dx, i) => (
        <circle key={dx} className="mascot-anim mascot-think-dot" cx={x + dx} cy={y - (i === 1 ? 3.5 : 0)} r={3.1} fill={color} />
      ))}
    </g>
  );
}

/** A small twinkling sparkle near the head — "working". */
export function Glint({ x, y }: { x: number; y: number }) {
  // IMPORTANT: same rule as the eyes/mouth above — `mascot-glint` animates CSS
  // `transform` (scale), so positioning must live on an outer, unanimated `<g>`.
  return (
    <g transform={`translate(${x},${y})`}>
      <path
        className="mascot-anim mascot-glint"
        d="M0,-6 C0.6,-2 2,-0.6 6,0 C2,0.6 0.6,2 0,6 C-0.6,2 -2,0.6 -6,0 C-2,-0.6 -0.6,-2 0,-6 Z"
        fill="#fff"
      />
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
