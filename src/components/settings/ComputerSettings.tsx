import type { Settings } from "@shared/types";
import { COMPUTER_SIZES } from "../../lib/computer";
import { IDLE_MINUTES, isValidIdleMinutes, type SettingsSectionProps } from "../../lib/settings";
import { Field } from "../ui/Field";
import { RadioCards } from "../ui/RadioCards";
import { SecretInput } from "../ui/SecretInput";

type ComputerDraft = Settings["computer"];

export function ComputerSettings({ draft, onChange, secrets, onSecretsChange }: SettingsSectionProps) {
  const computer = draft.computer;
  const update = (patch: Partial<ComputerDraft>) => onChange({ ...draft, computer: { ...computer, ...patch } });
  const idleValid = isValidIdleMinutes(computer.idleStopMinutes);

  return (
    <div className="space-y-6">
      <RadioCards
        label="Computer mode"
        value={computer.mode}
        onValueChange={(mode) => update({ mode })}
        options={[
          {
            value: "boat",
            label: "Boat cloud VM",
            description: "Each chat gets its own Linux VM on boat.dev that can install packages, run apps and share links.",
          },
          {
            value: "local",
            label: "Local sandboxed folder",
            description: "Commands run in a sandboxed folder on this machine. No cloud account needed.",
          },
          {
            value: "off",
            label: "Off",
            description: "No computer tools. TOT can still search the web and remember things.",
          },
        ]}
      />

      {computer.mode === "boat" && (
        <>
          <Field
            label="Boat API key"
            htmlFor="boat-key"
            hint={
              <>
                Create one in your{" "}
                <a href="https://boat.dev/dashboard" target="_blank" rel="noopener noreferrer" className="link">
                  boat.dev dashboard
                </a>
                .
              </>
            }
          >
            <SecretInput
              id="boat-key"
              placeholder="boat_…"
              value={secrets.boatApiKey}
              onChange={(boatApiKey) => onSecretsChange((s) => ({ ...s, boatApiKey, clearBoatApiKey: false }))}
              saved={computer.boatApiKeySet}
              cleared={secrets.clearBoatApiKey}
              onClearedChange={(clearBoatApiKey) => onSecretsChange((s) => ({ ...s, clearBoatApiKey }))}
            />
          </Field>

          <Field label="VM size" htmlFor="boat-size">
            <select
              id="boat-size"
              value={computer.size}
              onChange={(event) => update({ size: event.target.value as ComputerDraft["size"] })}
              className="input bg-elevated"
            >
              {COMPUTER_SIZES.map((size) => (
                <option key={size.value} value={size.value}>
                  {size.label}
                </option>
              ))}
            </select>
          </Field>
        </>
      )}

      {computer.mode !== "off" && (
        <Field
          label="Stop idle computers after"
          htmlFor="idle-minutes"
          hint="Idle computers are stopped and snapshotted, then start again when TOT needs them."
          error={!idleValid ? `Enter whole minutes between ${IDLE_MINUTES.min} and ${IDLE_MINUTES.max}.` : undefined}
        >
          <div className="flex items-center gap-2">
            <input
              id="idle-minutes"
              type="number"
              inputMode="numeric"
              min={IDLE_MINUTES.min}
              max={IDLE_MINUTES.max}
              value={Number.isNaN(computer.idleStopMinutes) ? "" : computer.idleStopMinutes}
              onChange={(event) => update({ idleStopMinutes: event.target.valueAsNumber })}
              aria-invalid={!idleValid}
              className="input w-28"
            />
            <span className="text-sm text-fg-muted">minutes</span>
          </div>
        </Field>
      )}
    </div>
  );
}
