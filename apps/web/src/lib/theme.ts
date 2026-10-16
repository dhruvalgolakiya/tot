import { useSyncExternalStore } from "react";

/**
 * Light / dark theme. The preference is per device (localStorage), so a phone
 * can follow its own setting. index.html applies it before first paint; this
 * module keeps <html class="dark"> and the browser chrome color in step.
 */

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "tot-theme";
/** Browser chrome (mobile address bar) color per theme: the canvas color. */
const CHROME: Record<ResolvedTheme, string> = { light: "#ffffff", dark: "#08080a" };

const media = window.matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();

function readPreference(): ThemePreference {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === "light" || saved === "dark" ? saved : "system";
  } catch {
    return "system";
  }
}

let preference = readPreference();
let resolved: ResolvedTheme = "dark";

function apply(): void {
  resolved = preference === "system" ? (media.matches ? "dark" : "light") : preference;
  document.documentElement.classList.toggle("dark", resolved === "dark");
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", CHROME[resolved]);
  for (const listener of listeners) listener();
}

export function setThemePreference(next: ThemePreference): void {
  preference = next;
  try {
    if (next === "system") localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);
  } catch {
    // Private mode: the choice lasts for this page only.
  }
  apply();
}

media.addEventListener("change", () => {
  if (preference === "system") apply();
});
// Keep other open tabs in step.
window.addEventListener("storage", (event) => {
  if (event.key !== STORAGE_KEY) return;
  preference = readPreference();
  apply();
});
apply();

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

export const useThemePreference = () => useSyncExternalStore(subscribe, () => preference);
export const useResolvedTheme = () => useSyncExternalStore(subscribe, () => resolved);
