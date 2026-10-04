// A single stylesheet, injected once into <head>, that drives every mascot's
// animation. Keeping this as one shared <style> (instead of one per <svg>) matters
// when many mascots are on screen at once (sidebar, gallery): the CSS text isn't
// duplicated per instance, and the browser only has to parse it once.
//
// Every state-driven look is either:
//  - a plain CSS rule (a "pose": e.g. working's squint) — always applied, and
//  - an `animation` (a "loop": e.g. idle's breathing) — applied only inside the
//    `prefers-reduced-motion: no-preference` block, so reduced-motion users get the
//    static pose with no motion at all, per the mascot spec.
//
// Per-instance timing (blink/gaze/etc.) is randomized via CSS custom properties set
// inline by <Mascot> (`--m-blink`, `--m-gaze`, ...), derived from a hash of the spec
// so a given mascot always blinks on the same rhythm but many different mascots on
// screen desync from each other — no per-mascot JS timers involved.

const STYLE_ID = "tot-mascot-styles";

const MASCOT_CSS = `
.mascot { display: inline-block; overflow: visible; }
/* will-change pre-promotes each animated group to its own stable compositing layer.
   Without it, Chromium's software rasterizer (as used by headless screenshot tools,
   and occasionally low-power GPU paths) can mis-cache the fill-box bounding rect of a
   transform-animated <g> and leave a stray painted fragment near its pre-animation
   corner. Pre-promoting avoids the per-frame bounding-box recalculation entirely. */
.mascot-anim { transform-box: fill-box; transform-origin: 50% 50%; will-change: transform; }

/* Cut-outs (hats, the pear's stem) are near-black on light backgrounds and off-white on dark ones,
   so the parts sticking out past the body never vanish into the canvas. */
.mascot .mascot-cutout { color: #18171d; }
.dark .mascot .mascot-cutout { color: #f3efe6; }

/* Static poses — always applied, independent of motion preference. */
.mascot--working .mascot-eyes-wrap { transform: scaleY(0.82); }
.mascot--working .mascot-pupil { transform: translate(-1.8px, 1.4px); }
.mascot--thinking .mascot-pupil { transform: translate(0.6px, -3px); }
.mascot--error .mascot-pupil { transform: translate(-1.8px, -0.8px) scale(0.8); }

@media (prefers-reduced-motion: no-preference) {
  .mascot--idle .mascot-body-anim,
  .mascot--sleeping .mascot-body-anim {
    animation: mascot-breathe 4.4s ease-in-out infinite;
    animation-delay: calc(var(--m-breathe, 0s) * -1);
  }
  .mascot--sleeping .mascot-body-anim { animation-duration: 6.2s; }
  .mascot--speaking .mascot-body-anim {
    animation: mascot-sway 2.4s ease-in-out infinite;
    animation-delay: calc(var(--m-breathe, 0s) * -1);
  }
  .mascot--working .mascot-body-anim {
    animation: mascot-bounce 0.82s cubic-bezier(0.45, 0, 0.55, 1) infinite;
  }
  .mascot--happy .mascot-body-anim {
    animation: mascot-hop 0.58s cubic-bezier(0.34, 1.56, 0.64, 1) 2 both;
  }
  .mascot--error .mascot-body-anim {
    animation: mascot-shake 0.46s ease-in-out 1 both;
  }

  .mascot--idle .mascot-eyes-blink,
  .mascot--thinking .mascot-eyes-blink,
  .mascot--speaking .mascot-eyes-blink,
  .mascot--happy .mascot-eyes-blink {
    animation: mascot-blink 5.4s ease-in-out infinite;
    animation-delay: calc(var(--m-blink, 0s) * -1);
  }

  .mascot--idle .mascot-pupil,
  .mascot--speaking .mascot-pupil {
    animation: mascot-gaze 7.2s ease-in-out infinite;
    animation-delay: calc(var(--m-gaze, 0s) * -1);
  }
  .mascot--thinking .mascot-pupil {
    animation: mascot-think-gaze 2.8s ease-in-out infinite;
    animation-delay: calc(var(--m-gaze, 0s) * -1);
  }

  .mascot--speaking .mascot-mouth-anim {
    animation: mascot-talk 0.4s ease-in-out infinite;
    animation-delay: calc(var(--m-gaze, 0s) * -1);
  }

  .mascot-think-dot { animation: mascot-dot-pulse 1.3s ease-in-out infinite; }
  .mascot-think-dot:nth-child(1) { animation-delay: calc(var(--m-think, 0s) * -1); }
  .mascot-think-dot:nth-child(2) { animation-delay: calc((var(--m-think, 0s) * -1) + 0.16s); }
  .mascot-think-dot:nth-child(3) { animation-delay: calc((var(--m-think, 0s) * -1) + 0.32s); }

  .mascot-glint {
    animation: mascot-glint 1.5s ease-in-out infinite;
    animation-delay: calc(var(--m-glint, 0s) * -1);
  }
  .mascot-antenna-tip {
    animation: mascot-glow-pulse 2.3s ease-in-out infinite;
    animation-delay: calc(var(--m-glint, 0s) * -1);
  }

  .mascot-z:nth-child(1) {
    animation: mascot-z-float 2.3s ease-in infinite;
    animation-delay: calc(var(--m-z, 0s) * -1);
  }
  .mascot-z:nth-child(2) {
    animation: mascot-z-float 2.3s ease-in infinite;
    animation-delay: calc((var(--m-z, 0s) * -1) + 0.9s);
  }

  .mascot-stage-enter {
    animation: mascot-bounce-in 0.72s cubic-bezier(0.22, 1.6, 0.36, 1) 1 both;
  }
}

@keyframes mascot-breathe {
  0%, 100% { transform: translateY(0) scaleY(1); }
  50% { transform: translateY(-2.4px) scaleY(1.018); }
}
@keyframes mascot-sway {
  0%, 100% { transform: rotate(-1.6deg); }
  50% { transform: rotate(1.6deg); }
}
@keyframes mascot-bounce {
  0%, 100% { transform: translateY(0); }
  42% { transform: translateY(-4.2px); }
  60% { transform: translateY(0.6px); }
}
@keyframes mascot-hop {
  0% { transform: translateY(0) scale(1, 1); }
  28% { transform: translateY(2px) scale(1.14, 0.84); }
  55% { transform: translateY(-14px) scale(0.9, 1.12); }
  78% { transform: translateY(0) scale(1.08, 0.94); }
  100% { transform: translateY(0) scale(1, 1); }
}
@keyframes mascot-shake {
  0%, 100% { transform: translateX(0) rotate(0); }
  20% { transform: translateX(-3.4px) rotate(-2.2deg); }
  40% { transform: translateX(3px) rotate(2deg); }
  60% { transform: translateX(-2px) rotate(-1.2deg); }
  80% { transform: translateX(1.4px) rotate(0.6deg); }
}
@keyframes mascot-blink {
  0%, 88%, 100% { transform: scaleY(1); }
  93% { transform: scaleY(0.1); }
  97% { transform: scaleY(1); }
}
@keyframes mascot-gaze {
  0%, 38% { transform: translate(0, 0); }
  46% { transform: translate(-3.4px, -1px); }
  62% { transform: translate(-3.4px, -1px); }
  70% { transform: translate(0.6px, 1px); }
  84% { transform: translate(0.6px, 1px); }
  100% { transform: translate(0, 0); }
}
@keyframes mascot-think-gaze {
  0%, 100% { transform: translate(0.6px, -3px); }
  50% { transform: translate(-1.8px, -3.2px); }
}
@keyframes mascot-talk {
  0%, 100% { transform: scaleY(0.32); }
  50% { transform: scaleY(1); }
}
@keyframes mascot-dot-pulse {
  0%, 100% { transform: translateY(0); opacity: 0.35; }
  50% { transform: translateY(-3.6px); opacity: 1; }
}
@keyframes mascot-glint {
  0%, 100% { transform: scale(0.5); opacity: 0; }
  50% { transform: scale(1); opacity: 1; }
}
@keyframes mascot-glow-pulse {
  0%, 100% { opacity: 0.5; }
  50% { opacity: 1; }
}
@keyframes mascot-z-float {
  0% { transform: translateY(0) scale(0.7); opacity: 0; }
  18% { opacity: 1; }
  100% { transform: translateY(-15px) scale(1.1); opacity: 0; }
}
@keyframes mascot-bounce-in {
  0% { transform: scale(0.3) translateY(26px); opacity: 0; }
  55% { transform: scale(1.08) translateY(-7px); opacity: 1; }
  75% { transform: scale(0.95) translateY(2px); }
  100% { transform: scale(1) translateY(0); }
}
`;

let injected = false;

/** Injects the shared mascot stylesheet into <head> at most once (idempotent, safe under HMR). */
export function ensureMascotStyles(): void {
  if (injected || typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) {
    injected = true;
    return;
  }
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = MASCOT_CSS;
  document.head.appendChild(style);
  injected = true;
}
