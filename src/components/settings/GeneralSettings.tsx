import { displayLabel, groupModels, modelLabel } from "../../lib/models";
import type { SettingsSectionProps } from "../../lib/settings";
import { goToSettings, useStore } from "../../store";
import { Card } from "../ui/Card";
import { Field } from "../ui/Field";
import { Switch } from "../ui/Switch";
import { SettingRow } from "./SettingRow";
import { ThemePicker } from "./ThemePicker";

export function GeneralSettings({ draft, onChange }: SettingsSectionProps) {
  const models = useStore((s) => s.models);
  const groups = groupModels(models);
  const knownDefault = models.some((m) => m.id === draft.defaultModelId);

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
          className="input"
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
          className="input min-h-32 resize-y leading-relaxed"
        />
      </Field>

      <Field label="Default model" htmlFor="settings-model" hint="Used for new chats. You can switch models in any chat.">
        <select
          id="settings-model"
          value={draft.defaultModelId}
          onChange={(event) => onChange({ ...draft, defaultModelId: event.target.value })}
          className="input bg-elevated"
        >
          {!knownDefault && <option value={draft.defaultModelId}>{modelLabel(models, draft.defaultModelId)}</option>}
          {groups.auto.map((model) => (
            <option key={model.id} value={model.id} disabled={!model.available}>
              {displayLabel(model)}
            </option>
          ))}
          {groups.claude.length > 0 && (
            <optgroup label="Claude">
              {groups.claude.map((model) => (
                <option key={model.id} value={model.id} disabled={!model.available}>
                  {model.label}
                </option>
              ))}
            </optgroup>
          )}
          {groups.chatgpt.length > 0 && (
            <optgroup label="ChatGPT">
              {groups.chatgpt.map((model) => (
                <option key={model.id} value={model.id} disabled={!model.available}>
                  {model.label}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </Field>

      <Card padding="none">
        <SettingRow
          htmlFor="settings-memory"
          title="Memory"
          description="Let TOT save useful facts and recall them in future chats."
          className="px-4"
          control={
            <Switch
              id="settings-memory"
              checked={draft.memory.enabled}
              onCheckedChange={(enabled) => onChange({ ...draft, memory: { ...draft.memory, enabled } })}
            />
          }
        />
        <div className="border-t border-hairline px-4 py-3">
          <button type="button" onClick={() => goToSettings("memory")} className="link-muted text-xs">
            Manage memories →
          </button>
        </div>
      </Card>
    </div>
  );
}
