import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { TotLogo } from "../components/TotLogo";
import { Button } from "../components/ui";
import { errorMessage } from "../lib/api";
import { connectOpen, lastAddress, parseSignInLink, probe, serverLabel, signIn, stopAdding, switchServer, useConnection } from "../lib/connection";
import { font, type as typeScale, useColors } from "../theme";

/**
 * Connect to a TOT: scan the QR code from Settings → Devices → Add a phone (address and a one-time code in one),
 * or type the address and the password set there. A TOT with sign-in off (this Mac's simulator) needs no password.
 */
export default function Connect() {
  const colors = useColors();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [address, setAddress] = useState("");
  const [password, setPassword] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const passwordRef = useRef<TextInput>(null);
  // Opened from Settings → TOT servers to add another, over the TOT that's open; else the saved ones to go back to.
  const adding = useConnection((s) => s.adding);
  const saved = useConnection((s) => s.servers);

  useEffect(() => {
    if (adding) return;
    void lastAddress().then((url) => url && setAddress((current) => current || url));
  }, [adding]);

  // Leaving Connect any way (back swipe, a successful sign-in) ends adding.
  useEffect(() => stopAdding, []);

  const cancel = () => {
    stopAdding();
    router.back();
  };

  const go = async () => {
    setBusy(true);
    setError(null);
    try {
      // A pasted sign-in link works like a scanned one.
      const link = parseSignInLink(address);
      if (link) {
        await signIn(link.url, { code: link.code });
        return;
      }
      if (needsPassword) {
        await signIn(address, { password });
        return;
      }
      if ((await probe(address)) === "open") await connectOpen(address);
      else {
        setNeedsPassword(true);
        setTimeout(() => passwordRef.current?.focus(), 50);
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const input = [styles.input, typeScale.body, { color: colors.fg, backgroundColor: colors.fill, borderColor: colors.edge }];

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.canvas }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView contentContainerStyle={[styles.page, { paddingTop: insets.top + 56, paddingBottom: insets.bottom + 24 }]} keyboardShouldPersistTaps="handled">
        <View style={styles.logo}>
          <TotLogo size={28} />
        </View>
        <Text style={[styles.title, { color: colors.fgStrong }]}>{adding ? "Add a TOT" : "Connect to TOT"}</Text>
        <Text style={[typeScale.body, { color: colors.fgMuted, textAlign: "center" }]}>
          On your computer, open TOT → Settings → Devices → Add a phone, and scan its code.
        </Text>

        <Button label="Scan QR code" icon="maximize" onPress={() => router.push("/scan")} style={{ alignSelf: "stretch", marginTop: 28 }} />

        <View style={styles.or}>
          <View style={[styles.rule, { backgroundColor: colors.hairline }]} />
          <Text style={[typeScale.xs, { color: colors.fgSubtle }]}>or type its address</Text>
          <View style={[styles.rule, { backgroundColor: colors.hairline }]} />
        </View>

        <TextInput
          value={address}
          onChangeText={(text) => {
            setAddress(text);
            setNeedsPassword(false);
          }}
          placeholder="100.101.4.2:5173"
          placeholderTextColor={colors.fgSubtle}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="next"
          onSubmitEditing={() => void go()}
          style={input}
        />
        {needsPassword ? (
          <TextInput
            ref={passwordRef}
            value={password}
            onChangeText={setPassword}
            placeholder="Password"
            placeholderTextColor={colors.fgSubtle}
            secureTextEntry
            autoCapitalize="none"
            returnKeyType="go"
            onSubmitEditing={() => void go()}
            style={[input, { marginTop: 10 }]}
          />
        ) : null}
        {error ? <Text style={[typeScale.sm, { color: colors.danger, marginTop: 10 }]}>{error}</Text> : null}
        <Button
          label={needsPassword ? "Sign in" : "Continue"}
          variant="secondary"
          busy={busy}
          disabled={!address.trim() || (needsPassword && !password)}
          onPress={() => void go()}
          style={{ alignSelf: "stretch", marginTop: 12 }}
        />
        {adding ? <Button label="Cancel" variant="ghost" onPress={cancel} style={{ alignSelf: "stretch", marginTop: 4 }} /> : null}
        {!adding && saved.length ? (
          <View style={{ alignSelf: "stretch", marginTop: 24, gap: 8 }}>
            <Text style={[typeScale.xs, { color: colors.fgSubtle, textAlign: "center" }]}>Or open a TOT this phone is signed in to</Text>
            {saved.map((server) => (
              <Button key={server.id} label={serverLabel(server)} icon="monitor" variant="secondary" onPress={() => void switchServer(server.id)} />
            ))}
          </View>
        ) : null}
        <Text style={[typeScale.xs, { color: colors.fgSubtle, textAlign: "center", marginTop: 20 }]}>
          The app talks only to your own TOT, over your Wi‑Fi or Tailscale. Nothing is kept on this phone but the address, your sign-in and the last lists it showed.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  page: { paddingHorizontal: 24, alignItems: "center" },
  logo: { marginBottom: 20 },
  title: { fontFamily: font.semibold, fontSize: 26, lineHeight: 34, letterSpacing: -0.5, marginBottom: 8 },
  or: { flexDirection: "row", alignItems: "center", gap: 10, alignSelf: "stretch", marginVertical: 20 },
  rule: { flex: 1, height: StyleSheet.hairlineWidth },
  input: { alignSelf: "stretch", height: 46, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14 },
});
