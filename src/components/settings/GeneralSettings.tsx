import { modelSelectOptions } from "../../lib/models";
import type { SettingsSectionProps } from "../../lib/settings";
import { goToSettings, useStore } from "../../store";
import { Field } from "../ui/Field";
import { Select } from "../ui/Select";
import { Switch } from "../ui/Switch";
import { SettingRow } from "./SettingRow";
import { ThemePicker } from "./ThemePicker";

export function GeneralSettings({ draft, onChange }: SettingsSectionProps) {
  const models = useStore((s) => s.models);

  return (
    <div className="space-y-6">
      <Field label="Appearance" hint="Follows your device unless you pick one. Saved on this device.">
        <div>
          <ThemePicker />
        </div>
      </Field>

      <Field label="Your name" htmlFor="settings-name" hint="TOT uses this when it talks to you.">
        <input
          id="settings-name"
          value={draft.userName}
          onChange={(event) => onChange({ ...draft, userName: event.target.value })}
          placeholder="e.g. Alex"
          maxLength={80}
          autoComplete="name"
          className="input h-10 rounded-xl"
        />
      </Field>

      <Field
        label="Custom instructions"
        htmlFor="settings-instructions"
        hint="Added to every chat. What should TOT know about you, and how should it respond?"
      >
        <textarea
          id="settings-instructions"
          rows={6}
          value={draft.customInstructions}
          onChange={(event) => onChange({ ...draft, customInstructions: event.target.value })}
          placeholder="e.g. I'm a frontend engineer in Berlin. Keep answers short and use TypeScript for code."
          className="input min-h-32 resize-y rounded-xl leading-relaxed"
        />
      </Field>

      <Field label="Default model" htmlFor="settings-model" hint="Used for new chats. You can switch models in any chat.">
        <Select
          id="settings-model"
          value={draft.defaultModelId}
          onValueChange={(defaultModelId) => onChange({ ...draft, defaultModelId })}
          className="h-10 rounded-xl"
          options={modelSelectOptions(models, draft.defaultModelId)}
        />
      </Field>

      <div className="border-t border-hairline pt-5">
        <SettingRow
          htmlFor="settings-memory"
          title="Memory"
          description="Let TOT save useful facts and recall them in future chats."
          control={
            <Switch
              id="settings-memory"
              checked={draft.memory.enabled}
              onCheckedChange={(enabled) => onChange({ ...draft, memory: { ...draft.memory, enabled } })}
            />
          }
        />
        <button type="button" onClick={() => goToSettings("memory")} className="link-muted text-xs">
          Manage memories →
        </button>
      </div>
    </div>
  );
}
