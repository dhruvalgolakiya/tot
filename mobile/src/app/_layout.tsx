import { Inter_400Regular, Inter_500Medium, Inter_600SemiBold, useFonts } from "@expo-google-fonts/inter";
import * as Notifications from "expo-notifications";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import * as SystemUI from "expo-system-ui";
import { useEffect } from "react";
import { AppState, useColorScheme, View } from "react-native";
import { loadAppearance } from "../lib/appearance";
import { loadConnection, useConnection } from "../lib/connection";
import { loadNotifyPrefs, notifyFor, type NotifyTarget, refreshPermission, targetOf } from "../lib/notify";
import { hydrate, loadAll, retryNow, startLive, stopLive } from "../lib/store";
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
    void loadAppearance();
    void loadNotifyPrefs();
  }, []);

  useEffect(() => {
    void SystemUI.setBackgroundColorAsync(colors.canvas);
  }, [colors.canvas]);

  // Signed in: load everything and keep it live. Signed out (or refused): drop it all.
  useEffect(() => {
    // Before loadAll: its catch-up reads what this TOT already notified.
    notifyFor(url);
    if (!url) return;
    // The last lists from this TOT first (instant, and all there is while it's unreachable), then the TOT's own.
    void hydrate(url).then(() => loadAll());
    startLive();
    return stopLive;
  }, [url, token]);

  // iOS drops connections in the background; coming back, reload (a dropped event stream reconnects by itself).
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active") return;
      // Allowed or turned off in iOS Settings while away.
      void refreshPermission().catch(() => {});
      if (!useConnection.getState().url) return;
      // A stream that ended for good (a refused request, say) starts again; one waiting out a backoff tries now.
      startLive();
      retryNow();
    });
    return () => sub.remove();
  }, []);

  // A tapped notification opens its chat or task (or the Tasks board for a summary), once signed in and loaded,
  // including the one that launched the app.
  const appLoaded = loaded && Boolean(url) && fontsLoaded;
  useEffect(() => {
    if (!appLoaded) return;
    const open = (target: NotifyTarget | null) => {
      if (!target) return;
      if ("screen" in target) router.push("/tasks");
      else router.push({ pathname: "/chat/[id]", params: { id: target.conversationId } });
    };
    const launched = Notifications.getLastNotificationResponse();
    if (launched) {
      open(targetOf(launched));
      void Notifications.clearLastNotificationResponseAsync().catch(() => {});
    }
    const sub = Notifications.addNotificationResponseReceivedListener((response) => {
      open(targetOf(response));
      void Notifications.clearLastNotificationResponseAsync().catch(() => {});
    });
    return () => sub.remove();
  }, [appLoaded, router]);

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
        <Stack.Screen name="tasks" options={{ title: "Tasks" }} />
        <Stack.Screen name="project/[id]" options={{ title: "" }} />
        <Stack.Screen name="settings/index" options={{ title: "Settings" }} />
        <Stack.Screen name="settings/general" options={{ title: "General" }} />
        <Stack.Screen name="settings/models" options={{ title: "Models & accounts" }} />
        <Stack.Screen name="settings/tasks" options={{ title: "Tasks" }} />
        <Stack.Screen name="settings/memory" options={{ title: "Memory" }} />
        <Stack.Screen name="settings/devices" options={{ title: "Devices" }} />
        <Stack.Screen name="settings/notifications" options={{ title: "Notifications" }} />
        <Stack.Screen name="knowledge/index" options={{ title: "" }} />
        <Stack.Screen name="knowledge/page" options={{ title: "" }} />
        <Stack.Screen name="knowledge/facts" options={{ title: "Facts" }} />
        <Stack.Screen name="knowledge/history" options={{ title: "History" }} />
        <Stack.Screen name="agent-settings/[id]" options={{ title: "Agent settings" }} />
        <Stack.Screen name="new-agent" options={{ presentation: "modal", title: "New agent" }} />
        <Stack.Screen name="models" options={{ presentation: "formSheet", title: "Model", sheetAllowedDetents: [0.6, 1], sheetGrabberVisible: true }} />
      </Stack>
    </>
  );
}
