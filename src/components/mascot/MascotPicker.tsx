// The mascot editor: a live preview with a state switcher, then grids for shape,
// color, eyes, and accessory, plus a "Surprise me" randomizer. Deliberately
// self-contained (no imports from src/components/ui) so it stays decoupled from the
// rest of the app shell — styled to match it by hand instead.
import { useState } from "react";
import clsx from "clsx";
import { Check, Shuffle } from "lucide-react";
import type { MascotSpec, MascotState } from "@shared/types";
import { MASCOT_ACCESSORIES, MASCOT_COLORS, MASCOT_EYES, MASCOT_SHAPES, mascotLabel, randomMascot, suggestName } from "./catalog";
import { Mascot } from "./Mascot";
import { derivePalette, relativeLuminance, withAlpha } from "./utils";

export interface MascotPickerProps {
  value: MascotSpec;
  onChange: (spec: MascotSpec) => void;
  className?: string;
}

const PREVIEW_STATES: readonly MascotState[] = ["idle", "thinking", "working", "speaking", "happy", "error", "sleeping"];

const chip =
  "inline-flex items-center justify-center rounded-lg border border-edge bg-fill-subtle px-2.5 py-1 text-xs text-fg-muted " +
  "transition-colors hover:bg-hover hover:text-fg";

const tile = "group relative flex items-center justify-center rounded-xl border p-2 transition-colors";

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="label-caps">{label}</span>
      {children}
    </div>
  );
}

export function MascotPicker({ value, onChange, className }: MascotPickerProps) {
  const [pinned, setPinned] = useState<MascotState>("idle");
  const [hovered, setHovered] = useState<MascotState | null>(null);
  const previewState = hovered ?? pinned;
  const palette = derivePalette(value.color);

  return (
    <div className={clsx("flex flex-col gap-5", className)}>
      <div className="flex flex-col items-center gap-4 rounded-xl border border-hairline bg-fill-subtle p-6">
        <div className="relative grid place-items-center">
          <div
            className="absolute inset-0 -z-10 rounded-full"
            style={{ background: withAlpha(palette.glow, 0.2), transform: "scale(1.2)" }}
            aria-hidden="true"
          />
          <Mascot spec={value} state={previewState} size={132} title={mascotLabel(value)} />
        </div>
        <div className="flex flex-wrap justify-center gap-1.5" role="group" aria-label="Preview state">
          {PREVIEW_STATES.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={pinned === s}
              onClick={() => setPinned(s)}
              onMouseEnter={() => setHovered(s)}
              onMouseLeave={() => setHovered(null)}
              onFocus={() => setHovered(s)}
              onBlur={() => setHovered(null)}
              className={clsx(chip, "capitalize", pinned === s && "border-accent-edge bg-accent-soft text-accent-text")}
            >
              {s}
            </button>
          ))}
        </div>
        <p className="text-xs text-fg-subtle">
          <span className="text-fg-muted">{suggestName(value)}</span> the {mascotLabel(value)}
        </p>
      </div>

      <Section label="Shape">
        <div className="grid grid-cols-5 gap-2" role="group" aria-label="Shape">
          {MASCOT_SHAPES.map((shape) => {
            const active = value.shape === shape;
            return (
              <button
                key={shape}
                type="button"
                title={shape}
                aria-pressed={active}
                onClick={() => onChange({ ...value, shape })}
                className={clsx(tile, active ? "border-accent-edge bg-accent-soft" : "border-edge bg-fill-subtle hover:bg-hover")}
              >
                <Mascot spec={{ ...value, shape }} size={36} />
              </button>
            );
          })}
        </div>
      </Section>

      <Section label="Color">
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Color">
          {MASCOT_COLORS.map((c) => {
            const active = value.color.toLowerCase() === c.toLowerCase();
            const checkColor = relativeLuminance(c) > 0.42 ? "#14151a" : "#ffffff";
            return (
              <button
                key={c}
                type="button"
                title={c}
                aria-pressed={active}
                onClick={() => onChange({ ...value, color: c })}
                className="grid size-8 place-items-center rounded-full ring-1 ring-edge transition-shadow hover:ring-edge-strong"
                style={{ backgroundColor: c }}
              >
                {active && <Check size={14} strokeWidth={3} color={checkColor} />}
              </button>
            );
          })}
          <label
            className="relative grid size-8 cursor-pointer place-items-center rounded-full ring-1 ring-dashed ring-edge-strong text-fg-subtle hover:text-fg"
            title="Custom color"
          >
            <span aria-hidden="true" className="text-sm leading-none">
              +
            </span>
            <span className="sr-only">Custom color</span>
            <input
              type="color"
              value={value.color}
              onChange={(e) => onChange({ ...value, color: e.target.value })}
              className="absolute inset-0 size-full cursor-pointer opacity-0"
            />
          </label>
        </div>
      </Section>

      <Section label="Eyes">
        <div className="grid grid-cols-4 gap-2" role="group" aria-label="Eyes">
          {MASCOT_EYES.map((eyes) => {
            const active = value.eyes === eyes;
            return (
              <button
                key={eyes}
                type="button"
                title={eyes}
                aria-pressed={active}
                onClick={() => onChange({ ...value, eyes })}
                className={clsx(tile, active ? "border-accent-edge bg-accent-soft" : "border-edge bg-fill-subtle hover:bg-hover")}
              >
                <Mascot spec={{ ...value, eyes }} size={36} />
              </button>
            );
          })}
        </div>
      </Section>

      <Section label="Accessory">
        <div className="grid grid-cols-5 gap-2" role="group" aria-label="Accessory">
          {MASCOT_ACCESSORIES.map((accessory) => {
            const active = value.accessory === accessory;
            return (
              <button
                key={accessory}
                type="button"
                title={accessory}
                aria-pressed={active}
                onClick={() => onChange({ ...value, accessory })}
                className={clsx(tile, active ? "border-accent-edge bg-accent-soft" : "border-edge bg-fill-subtle hover:bg-hover")}
              >
                <Mascot spec={{ ...value, accessory }} size={36} />
              </button>
            );
          })}
        </div>
      </Section>

      <button
        type="button"
        onClick={() => onChange(randomMascot())}
        className="inline-flex items-center justify-center gap-2 self-start rounded-lg border border-edge bg-fill-subtle px-3.5 py-2 text-sm text-fg-muted transition-colors hover:bg-hover hover:text-fg"
      >
        <Shuffle size={16} />
        Surprise me
      </button>
    </div>
  );
}
