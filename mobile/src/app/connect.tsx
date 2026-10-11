import { useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Button } from "../components/ui";
import { errorMessage } from "../lib/api";
import { connectOpen, lastAddress, parseSignInLink, probe, signIn } from "../lib/connection";
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

  useEffect(() => {
    void lastAddress().then((url) => url && setAddress((current) => current || url));
  }, []);

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
        <View style={[styles.logo, { borderColor: colors.fg }]}>
          <View style={[styles.logoInner, { borderColor: colors.fg }]} />
        </View>
        <Text style={[styles.title, { color: colors.fgStrong }]}>Connect to TOT</Text>
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
        <Text style={[typeScale.xs, { color: colors.fgSubtle, textAlign: "center", marginTop: 20 }]}>
          The app talks only to your own TOT, over your Wi‑Fi or Tailscale. Nothing is stored on this phone but the address and your sign-in.
        </Text>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  page: { paddingHorizontal: 24, alignItems: "center" },
  logo: { width: 44, height: 44, borderRadius: 22, borderWidth: 2.5, alignItems: "center", justifyContent: "center", marginBottom: 20 },
  logoInner: { width: 18, height: 18, borderRadius: 9, borderWidth: 2.5 },
  title: { fontFamily: font.semibold, fontSize: 26, lineHeight: 34, letterSpacing: -0.5, marginBottom: 8 },
  or: { flexDirection: "row", alignItems: "center", gap: 10, alignSelf: "stretch", marginVertical: 20 },
  rule: { flex: 1, height: StyleSheet.hairlineWidth },
  input: { alignSelf: "stretch", height: 46, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14 },
});
