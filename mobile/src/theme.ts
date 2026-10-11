import { useColorScheme } from "react-native";

/**
 * The web app's tokens (DESIGN.md, src/index.css), as plain colors: true neutral greys, light and dark
 * following the system. Status colors carry status only; nothing gets a colored side bar.
 */
const dark = {
  canvas: "#212121",
  panel: "#181818",
  elevated: "#2b2b2b",
  bubble: "#303030",
  fgStrong: "#fafafa",
  fg: "#ececec",
  fgMuted: "#b4b4b4",
  fgSubtle: "#8f8f8f",
  fgFaint: "#5d5d5d",
  hairline: "rgba(255,255,255,0.08)",
  edge: "rgba(255,255,255,0.12)",
  fill: "rgba(255,255,255,0.06)",
  fillStrong: "rgba(255,255,255,0.1)",
  selected: "rgba(255,255,255,0.08)",
  success: "#4ade80",
  warning: "#fbbf24",
  danger: "#f87171",
  link: "#7cb3ff",
  codeBg: "#171717",
};

const light: typeof dark = {
  canvas: "#ffffff",
  panel: "#f9f9f9",
  elevated: "#ffffff",
  bubble: "#f4f4f4",
  fgStrong: "#0d0d0d",
  fg: "#171717",
  fgMuted: "#5d5d5d",
  fgSubtle: "#8f8f8f",
  fgFaint: "#b4b4b4",
  hairline: "rgba(0,0,0,0.07)",
  edge: "rgba(0,0,0,0.12)",
  fill: "rgba(0,0,0,0.04)",
  fillStrong: "rgba(0,0,0,0.08)",
  selected: "rgba(0,0,0,0.06)",
  success: "#16a34a",
  warning: "#d97706",
  danger: "#dc2626",
  link: "#2563eb",
  codeBg: "#f6f6f6",
};

export type Colors = typeof dark;

export function useColors(): Colors {
  return useColorScheme() === "light" ? light : dark;
}

export const font = {
  regular: "Inter_400Regular",
  medium: "Inter_500Medium",
  semibold: "Inter_600SemiBold",
  mono: "Menlo",
};

/** DESIGN.md's type scale, in points. */
export const type = {
  title: { fontFamily: font.semibold, fontSize: 20, lineHeight: 28, letterSpacing: -0.3 },
  heading: { fontFamily: font.semibold, fontSize: 15, lineHeight: 22, letterSpacing: -0.15 },
  chat: { fontFamily: font.regular, fontSize: 16, lineHeight: 26 },
  body: { fontFamily: font.regular, fontSize: 15, lineHeight: 22 },
  sm: { fontFamily: font.regular, fontSize: 14, lineHeight: 20 },
  ui: { fontFamily: font.regular, fontSize: 13, lineHeight: 18 },
  xs: { fontFamily: font.regular, fontSize: 12, lineHeight: 16 },
} as const;
