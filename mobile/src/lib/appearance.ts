import * as SecureStore from "expo-secure-store";
import { Appearance } from "react-native";
import { create } from "zustand";

/**
 * Settings → General → Theme, like the web's (System / Light / Dark, saved on this device). It's the phone's own
 * choice, not the TOT's, so it's kept here; Appearance makes every useColorScheme() follow it.
 */
export type ThemePreference = "system" | "light" | "dark";

const KEY = "tot.theme";

export const useAppearance = create<{ preference: ThemePreference }>()(() => ({ preference: "system" }));

function apply(preference: ThemePreference) {
  Appearance.setColorScheme(preference === "system" ? "unspecified" : preference);
}

export async function loadAppearance() {
  const saved = await SecureStore.getItemAsync(KEY).catch(() => null);
  const preference: ThemePreference = saved === "light" || saved === "dark" ? saved : "system";
  useAppearance.setState({ preference });
  apply(preference);
}

export function setThemePreference(preference: ThemePreference) {
  useAppearance.setState({ preference });
  apply(preference);
  void SecureStore.setItemAsync(KEY, preference);
}
