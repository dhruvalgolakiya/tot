import { useEffect, useState } from "react";
import { totDesktop } from "../../lib/desktop";
import { modelSelectOptions } from "../../lib/models";
import type { SettingsSectionProps } from "../../lib/settings";
import { goToSettings, notifyError, useStore } from "../../store";
import { LedgerField, LedgerGroup } from "../ui/Ledger";
import { Select } from "../ui/Select";
import { Switch } from "../ui/Switch";
import { ThemePicker } from "./ThemePicker";

export function GeneralSettings({ draft, onChange }: SettingsSectionProps) {
  const models = useStore((s) => s.models);

  return (
    <div className="space-y-8">
      <LedgerGroup title="Appearance">
        <LedgerField title="Theme" description="Follows your device unless you pick one. Saved on this device." control={<ThemePicker />} />
      </LedgerGroup>

      <LedgerGroup title="About you">
        <LedgerField
          title="Your name"
          htmlFor="settings-name"
          description="TOT uses this when it talks to you."
          control={
            <input
              id="settings-name"
              value={draft.userName}
              onChange={(event) => onChange({ ...draft, userName: event.target.value })}
              placeholder="e.g. Alex"
              maxLength={80}
              autoComplete="name"
              className="input h-9 w-64 max-w-full rounded-xl"
            />
          }
        />
        <LedgerField
          stacked
          title="Custom instructions"
          htmlFor="settings-instructions"
          description="Added to every chat. What should TOT know about you, and how should it respond?"
          control={
            <textarea
              id="settings-instructions"
              rows={6}
              value={draft.customInstructions}
              onChange={(event) => onChange({ ...draft, customInstructions: event.target.value })}
              placeholder="e.g. I'm a frontend engineer in Berlin. Keep answers short and use TypeScript for code."
              className="input min-h-32 resize-y rounded-xl leading-relaxed"
            />
          }
        />
      </LedgerGroup>

      <LedgerGroup title="Chats">
        <LedgerField
          title="Default model"
          htmlFor="settings-model"
          description="Used for new chats. You can switch models in any chat."
          control={
            <Select
              id="settings-model"
              value={draft.defaultModelId}
              onValueChange={(defaultModelId) => onChange({ ...draft, defaultModelId })}
              className="h-9 w-64 max-w-full rounded-xl"
              options={modelSelectOptions(models, draft.defaultModelId)}
            />
          }
        />
        <LedgerField
          htmlFor="settings-memory"
          title="Memory"
          description={
            <>
              Let TOT save useful facts and recall them in future chats.{" "}
              <button type="button" onClick={() => goToSettings("memory")} className="link-muted">
                Manage memories
              </button>
            </>
          }
          control={
            <Switch
              id="settings-memory"
              checked={draft.memory.enabled}
              onCheckedChange={(enabled) => onChange({ ...draft, memory: { ...draft.memory, enabled } })}
            />
          }
        />
        {totDesktop && <OpenAtLoginRow />}
      </LedgerGroup>
    </div>
  );
}

/** Mac app only: the menu-bar "open at login" OS setting, read and set through electron/'s bridge. */
function OpenAtLoginRow() {
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(true); // starts true: loading the current state before it can be toggled

  useEffect(() => {
    totDesktop
      ?.getOpenAtLogin()
      .then(setChecked)
      .catch(notifyError)
      .finally(() => setBusy(false));
  }, []);

  async function toggle(next: boolean) {
    setBusy(true);
    try {
      setChecked(await totDesktop!.setOpenAtLogin(next));
    } catch (error) {
      notifyError(error);
    } finally {
      setBusy(false);
    }
  }

  return (
    <LedgerField
      htmlFor="settings-open-at-login"
      title="Open at login"
      description="Keeps TOT in the menu bar, so your phone and other devices can reach this computer."
      control={<Switch id="settings-open-at-login" checked={checked} disabled={busy} onCheckedChange={(next) => void toggle(next)} />}
    />
  );
}
