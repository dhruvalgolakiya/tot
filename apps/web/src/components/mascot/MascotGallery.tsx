// A dev-only visual index of the whole catalog: every shape, accessory, eye style,
// state, and size, plus a handful of colors. Exported for the app shell to mount at a
// route (e.g. /mascots) for quick visual QA — this file only provides the component.
import type { MascotShape, MascotSpec, MascotState } from "@tot/shared/types";
import { MASCOT_ACCESSORIES, MASCOT_COLORS, MASCOT_EYES, MASCOT_SHAPES, defaultMascot, mascotLabel } from "./catalog";
import { Mascot } from "./Mascot";
import { MascotStage } from "./MascotStage";

const STATES: readonly MascotState[] = ["idle", "thinking", "working", "speaking", "happy", "error", "sleeping"];
const SIZES: readonly number[] = [16, 20, 24, 32, 48, 64, 96, 140, 200];
const SAMPLE_SHAPES: readonly MascotShape[] = ["blob", "bot", "cat", "ghost"];
const ACCESSORY_DEMO: MascotSpec = { shape: "bot", color: "#60a5fa", eyes: "dots", accessory: "none" };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3 border-b border-white/10 pb-8">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-white/50">{title}</h2>
      <div className="flex flex-wrap items-end gap-4">{children}</div>
    </section>
  );
}

function Tile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.02] p-3">
      {children}
      <span className="max-w-20 text-center text-[10px] leading-tight text-white/40">{label}</span>
    </div>
  );
}

export function MascotGallery() {
  return (
    <div className="min-h-screen bg-[#0b0b0f] p-10 text-white">
      <div className="mx-auto flex max-w-5xl flex-col gap-10">
        <header className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold">Mascot Gallery</h1>
          <p className="text-sm text-white/50">Every shape, accessory, eye style, state, and size, for visual QA.</p>
        </header>

        <Section title="Hero">
          <MascotStage spec={defaultMascot} size={180} title="Tot" />
        </Section>

        <Section title="Shapes">
          {MASCOT_SHAPES.map((shape) => (
            <Tile key={shape} label={shape}>
              <Mascot spec={{ ...defaultMascot, shape }} size={72} />
            </Tile>
          ))}
        </Section>

        <Section title="Eyes">
          {MASCOT_EYES.map((eyes) => (
            <Tile key={eyes} label={eyes}>
              <Mascot spec={{ ...defaultMascot, eyes }} size={72} />
            </Tile>
          ))}
        </Section>

        <Section title="Accessories">
          {MASCOT_ACCESSORIES.map((accessory) => (
            <Tile key={accessory} label={accessory}>
              <Mascot spec={{ ...ACCESSORY_DEMO, accessory }} size={72} />
            </Tile>
          ))}
        </Section>

        <Section title="States">
          {STATES.map((state) => (
            <Tile key={state} label={state}>
              <Mascot spec={defaultMascot} state={state} size={72} />
            </Tile>
          ))}
        </Section>

        <Section title="Shapes x states">
          {SAMPLE_SHAPES.flatMap((shape) =>
            STATES.map((state) => (
              <Tile key={`${shape}-${state}`} label={`${shape} / ${state}`}>
                <Mascot spec={{ ...defaultMascot, shape }} state={state} size={60} />
              </Tile>
            )),
          )}
        </Section>

        <Section title="Sizes">
          {SIZES.map((size) => (
            <Tile key={size} label={`${size}px`}>
              <Mascot spec={defaultMascot} size={size} />
            </Tile>
          ))}
        </Section>

        <Section title="Colors">
          {MASCOT_COLORS.map((color) => (
            <Tile key={color} label={color}>
              <Mascot spec={{ ...defaultMascot, color }} size={72} />
            </Tile>
          ))}
        </Section>

        <Section title="Labels (aria-label preview)">
          {MASCOT_SHAPES.slice(0, 5).map((shape) => {
            const spec: MascotSpec = { ...defaultMascot, shape };
            return (
              <Tile key={shape} label={mascotLabel(spec)}>
                <Mascot spec={spec} size={56} />
              </Tile>
            );
          })}
        </Section>
      </div>
    </div>
  );
}
