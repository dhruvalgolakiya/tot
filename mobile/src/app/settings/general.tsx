import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Cell, FieldCell, Group, LoadState, Segmented, SettingsScroll, SwitchCell } from "../../components/settings";
import { setThemePreference, type ThemePreference, useAppearance } from "../../lib/appearance";
import { AUTO_MODEL_ID, modelLabel } from "../../lib/models";
import { openModelPicker } from "../../lib/picker";
import { loadAll, saveSettings, useStore } from "../../lib/store";

const THEMES: { value: ThemePreference; label: string; icon: "monitor" | "sun" | "moon" }[] = [
  { value: "system", label: "System", icon: "monitor" },
  { value: "light", label: "Light", icon: "sun" },
  { value: "dark", label: "Dark", icon: "moon" },
];

/**
 * Settings → General, as the web's: the theme (this phone's own), your name and custom instructions, the default
 * model for new chats, and memory on or off. Each change saves at once.
 */
export default function GeneralSettings() {
  const router = useRouter();
  const settings = useStore((s) => s.settings);
  const models = useStore((s) => s.models);
  const theme = useAppearance((s) => s.preference);
  const [name, setName] = useState(settings?.userName ?? "");
  const [instructions, setInstructions] = useState(settings?.customInstructions ?? "");
  useEffect(() => setName(settings?.userName ?? ""), [settings?.userName]);
  useEffect(() => setInstructions(settings?.customInstructions ?? ""), [settings?.customInstructions]);

  if (!settings) return <SettingsScroll><LoadState error="Couldn't load settings." onRetry={() => void loadAll()} /></SettingsScroll>;

  return (
    <SettingsScroll>
      <Group title="Appearance" footer="Follows your phone unless you pick one. Saved on this phone.">
        <Cell title={<Segmented label="Theme" value={theme} options={THEMES} onChange={setThemePreference} />} />
      </Group>

      <Group title="About you" footer="TOT uses your name when it talks to you. Custom instructions are added to every chat: what should TOT know about you, and how should it respond?">
        <FieldCell
          title="Your name"
          value={name}
          onChangeText={setName}
          onEndEditing={() => name.trim() !== settings.userName && void saveSettings({ userName: name.trim() })}
          placeholder="e.g. Alex"
          maxLength={80}
          autoComplete="name"
          returnKeyType="done"
        />
        <FieldCell
          value={instructions}
          onChangeText={setInstructions}
          onEndEditing={() => instructions !== settings.customInstructions && void saveSettings({ customInstructions: instructions })}
          multiline
          placeholder="e.g. I'm a frontend engineer in Berlin. Keep answers short and use TypeScript for code."
        />
      </Group>

      <Group title="Chats" footer="The default model is used for new chats; you can switch models in any chat. Memory lets TOT save useful facts and recall them in future chats.">
        <Cell
          title="Default model"
          value={modelLabel(models, settings.defaultModelId || AUTO_MODEL_ID)}
          chevron
          onPress={() =>
            openModelPicker({
              title: "Default model",
              deviceId: null,
              current: settings.defaultModelId || AUTO_MODEL_ID,
              onPick: (defaultModelId) => defaultModelId !== settings.defaultModelId && void saveSettings({ defaultModelId }),
            })
          }
        />
        <SwitchCell title="Memory" value={settings.memory.enabled} onValueChange={(enabled) => void saveSettings({ memory: { enabled } })} />
        <Cell title="Manage memories" chevron onPress={() => router.push("/settings/memory")} />
      </Group>
    </SettingsScroll>
  );
}
