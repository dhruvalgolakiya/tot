import type { Settings } from "@tot/shared/types";
import { COMPUTER_SIZES } from "../../lib/computer";
import { IDLE_MINUTES, isValidIdleMinutes, type SettingsSectionProps } from "../../lib/settings";
import { LedgerField, LedgerGroup } from "../ui/Ledger";
import { RadioCards } from "../ui/RadioCards";
import { SecretInput } from "../ui/SecretInput";
import { Select } from "../ui/Select";

type ComputerDraft = Settings["computer"];

export function ComputerSettings({ draft, onChange, secrets, onSecretsChange }: SettingsSectionProps) {
  const computer = draft.computer;
  const update = (patch: Partial<ComputerDraft>) => onChange({ ...draft, computer: { ...computer, ...patch } });
  const idleValid = isValidIdleMinutes(computer.idleStopMinutes);

  return (
    <div className="space-y-8">
      <LedgerGroup title="Computer">
        <LedgerField
          stacked
          title="Mode"
          description="Where TOT runs the commands it needs for each chat."
          control={
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
          }
        />
      </LedgerGroup>

      {computer.mode === "boat" && (
        <LedgerGroup title="Boat cloud VM">
          <LedgerField
            stacked
            title="Boat API key"
            htmlFor="boat-key"
            description={
              <>
                Create one in your{" "}
                <a href="https://boat.dev/dashboard" target="_blank" rel="noopener noreferrer" className="link">
                  boat.dev dashboard
                </a>
                .
              </>
            }
            control={
              <SecretInput
                id="boat-key"
                placeholder="boat_…"
                value={secrets.boatApiKey}
                onChange={(boatApiKey) => onSecretsChange((s) => ({ ...s, boatApiKey, clearBoatApiKey: false }))}
                saved={computer.boatApiKeySet}
                cleared={secrets.clearBoatApiKey}
                onClearedChange={(clearBoatApiKey) => onSecretsChange((s) => ({ ...s, clearBoatApiKey }))}
              />
            }
          />

          <LedgerField
            title="VM size"
            htmlFor="boat-size"
            control={
              <Select
                id="boat-size"
                value={computer.size}
                onValueChange={(size) => update({ size: size as ComputerDraft["size"] })}
                className="h-9 w-56 max-w-full rounded-xl"
                options={COMPUTER_SIZES.map((size) => ({ value: size.value, label: size.label }))}
              />
            }
          />
        </LedgerGroup>
      )}

      {computer.mode !== "off" && (
        <LedgerGroup title="Idle">
          <LedgerField
            title="Stop idle computers after"
            htmlFor="idle-minutes"
            description={
              !idleValid ? (
                <span className="text-danger">{`Enter whole minutes between ${IDLE_MINUTES.min} and ${IDLE_MINUTES.max}.`}</span>
              ) : (
                "Idle computers are stopped and snapshotted, then start again when TOT needs them."
              )
            }
            control={
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
                  className="input h-9 w-24 rounded-xl"
                />
                <span className="text-sm text-fg-muted">minutes</span>
              </div>
            }
          />
        </LedgerGroup>
      )}
    </div>
  );
}
