import { CameraView, useCameraPermissions } from "expo-camera";
import { useRouter } from "expo-router";
import { useRef, useState } from "react";
import { ActivityIndicator, Platform, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button, IconButton } from "../components/ui";
import { errorMessage } from "../lib/api";
import { parseSignInLink, signIn } from "../lib/connection";
import { type as typeScale } from "../theme";

/** Scans the sign-in QR code from Settings → Devices → Add a phone: "<address>/login#code=…", good once for 5 minutes. */
export default function Scan() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const [status, setStatus] = useState<{ busy: boolean; error: string | null }>({ busy: false, error: null });
  const handled = useRef(false);

  const onScan = async (data: string) => {
    if (handled.current) return;
    const link = parseSignInLink(data);
    if (!link) {
      setStatus({ busy: false, error: "That isn't a TOT sign-in code. Use Settings → Devices → Add a phone." });
      return;
    }
    handled.current = true;
    setStatus({ busy: true, error: null });
    try {
      await signIn(link.url, { code: link.code });
      // The root layout moves on to the agents once connected.
    } catch (e) {
      handled.current = false;
      setStatus({ busy: false, error: errorMessage(e) });
    }
  };

  return (
    <View style={styles.page}>
      {permission?.granted ? (
        <CameraView style={StyleSheet.absoluteFill} facing="back" barcodeScannerSettings={{ barcodeTypes: ["qr"] }} onBarcodeScanned={({ data }) => void onScan(data)} />
      ) : (
        <View style={styles.center}>
          <Text style={[typeScale.body, styles.text]}>TOT needs the camera to scan the code on your computer.</Text>
          {permission && !permission.canAskAgain ? (
            <Text style={[typeScale.sm, styles.muted]}>Turn it on in iOS Settings → TOT → Camera.</Text>
          ) : (
            <Button label="Allow camera" onDark onPress={() => void requestPermission()} style={{ marginTop: 16 }} />
          )}
        </View>
      )}
      {/* A modal sheet on iOS starts below the status bar; elsewhere the screen is full height. */}
      <View style={[styles.top, { paddingTop: Platform.OS === "ios" ? 12 : insets.top + 8 }]}>
        <IconButton name="x" label="Close" color="#fff" onPress={() => router.back()} />
      </View>
      {permission?.granted ? (
        <>
          <View style={styles.frame} pointerEvents="none" />
          <View style={[styles.bottom, { paddingBottom: insets.bottom + 24 }]}>
            {status.busy ? <ActivityIndicator color="#fff" /> : null}
            <Text style={[typeScale.sm, styles.text]}>{status.error ?? "Point at the code in Settings → Devices → Add a phone."}</Text>
          </View>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: "#000" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  top: { position: "absolute", top: 0, left: 8 },
  frame: { position: "absolute", alignSelf: "center", top: "30%", width: 240, height: 240, borderRadius: 24, borderWidth: 2, borderColor: "rgba(255,255,255,0.8)" },
  bottom: { position: "absolute", bottom: 0, left: 0, right: 0, alignItems: "center", gap: 10, paddingHorizontal: 32 },
  text: { color: "#fff", textAlign: "center" },
  muted: { color: "rgba(255,255,255,0.6)", textAlign: "center", marginTop: 8 },
});
