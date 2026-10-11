import { Inter_400Regular, Inter_500Medium, Inter_600SemiBold, useFonts } from "@expo-google-fonts/inter";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SystemUI from "expo-system-ui";
import { useEffect } from "react";
import { AppState, useColorScheme, View } from "react-native";
import { loadConnection, useConnection } from "../lib/connection";
import { loadAll, startLive, stopLive } from "../lib/store";
import { font, useColors } from "../theme";

export default function RootLayout() {
  const colors = useColors();
  const scheme = useColorScheme();
  const [fontsLoaded] = useFonts({ Inter_400Regular, Inter_500Medium, Inter_600SemiBold });
  const { loaded, url, token } = useConnection();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    void loadConnection();
  }, []);

  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(colors.canvas);
  }, [colors.canvas]);

  // Signed in: load everything and keep it live. Signed out (or refused): drop it all.
  useEffect(() => {
    if (!url) return;
    void loadAll();
    startLive();
    return stopLive;
  }, [url, token]);

  // iOS drops connections in the background; coming back, reload (a dropped event stream reconnects by itself).
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active" || !useConnection.getState().url) return;
      void loadAll();
      // A stream that ended for good (a refused request, say) starts again; a live one is left alone.
      startLive();
    });
    return () => sub.remove();
  }, []);

  // Not connected: the Connect screen (and its QR scanner) only.
  const onConnect = segments[0] === "connect" || segments[0] === "scan";
  useEffect(() => {
    if (!loaded) return;
    if (!url && !onConnect) {
      // Signed out from the Settings sheet (or from the computer, on any screen): close what's open first, so
      // Connect doesn't take the sheet's place.
      if (router.canDismiss()) router.dismissAll();
      router.replace("/connect");
    } else if (url && onConnect) router.replace("/");
  }, [loaded, url, onConnect, router]);

  if (!loaded || !fontsLoaded) return <View style={{ flex: 1, backgroundColor: colors.canvas }} />;

  return (
    <>
      <StatusBar style={scheme === "light" ? "dark" : "light"} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: colors.canvas },
          headerShadowVisible: false,
          headerTintColor: colors.fg,
          headerTitleStyle: { fontFamily: font.semibold, fontSize: 16, color: colors.fg },
          headerBackButtonDisplayMode: "minimal",
          contentStyle: { backgroundColor: colors.canvas },
        }}
      >
        <Stack.Screen name="index" options={{ title: "Agents" }} />
        <Stack.Screen name="connect" options={{ headerShown: false, animation: "fade" }} />
        <Stack.Screen name="scan" options={{ presentation: "modal", headerShown: false }} />
        <Stack.Screen name="agent/[id]" options={{ title: "" }} />
        <Stack.Screen name="chat/[id]" options={{ title: "" }} />
        <Stack.Screen name="settings" options={{ presentation: "formSheet", title: "Settings", sheetAllowedDetents: [0.6, 1], sheetGrabberVisible: true }} />
      </Stack>
    </>
  );
}
