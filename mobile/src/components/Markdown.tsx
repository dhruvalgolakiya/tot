import { type ReactNode, memo } from "react";
import { Linking, ScrollView, StyleSheet, Text, View } from "react-native";
import { type Colors, font, useColors } from "../theme";

/**
 * Enough Markdown for agents' replies: paragraphs, headings, lists, quotes, rules, fenced code, tables (as
 * monospace), and inline bold, italic, strikethrough, code and links. The React Native markdown libraries lag
 * React 19 and the New Architecture; this is small and has no native parts.
 */

type Block =
  | { kind: "p"; text: string }
  | { kind: "h"; level: number; text: string }
  | { kind: "code"; text: string }
  | { kind: "quote"; text: string }
  | { kind: "list"; ordered: boolean; start: number; items: { text: string; depth: number }[] }
  | { kind: "rule" }
  | { kind: "table"; rows: string[][] };

function parse(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence[1])) body.push(lines[i++]);
      i++;
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ kind: "h", level: heading[1].length, text: heading[2].replace(/\s+#+\s*$/, "") });
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ kind: "rule" });
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
      blocks.push({ kind: "quote", text: body.join("\n") });
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        const cells = lines[i++].trim().slice(1, -1).split("|").map((c) => c.trim());
        if (!cells.every((c) => /^:?-{2,}:?$/.test(c))) rows.push(cells);
      }
      blocks.push({ kind: "table", rows });
      continue;
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (item) {
      const ordered = /\d/.test(item[2]);
      const items: { text: string; depth: number }[] = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (m) {
          items.push({ text: m[3], depth: Math.min(Math.floor(m[1].length / 2), 3) });
          i++;
        } else if (lines[i].trim() && /^\s{2,}/.test(lines[i]) && items.length) {
          items[items.length - 1].text += ` ${lines[i++].trim()}`;
        } else break;
      }
      blocks.push({ kind: "list", ordered, start: ordered ? parseInt(item[2], 10) : 1, items });
      continue;
    }
    const body: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6}\s|\s*(```|~~~)|\s*>|\s*([-*+]|\d+[.)])\s+|\s*\|.*\|\s*$)/.test(lines[i])
    ) {
      body.push(lines[i++].trim());
    }
    blocks.push({ kind: "p", text: body.join("\n") });
  }
  return blocks;
}

// Inline: `code`, **bold**, __bold__, *italic*, _italic_, ~~strike~~, [text](url), bare URLs.
const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(~~[^~]+~~)|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s)]+)/g;

function inline(text: string, colors: Colors, key = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const token = match[0];
    const k = `${key}-${n++}`;
    if (match[1]) {
      out.push(
        <Text key={k} style={{ fontFamily: font.mono, fontSize: 14, backgroundColor: colors.fill }}>
          {` ${token.slice(1, -1)} `}
        </Text>,
      );
    } else if (match[2]) {
      out.push(<Text key={k} style={{ fontFamily: font.semibold }}>{inline(token.slice(2, -2), colors, k)}</Text>);
    } else if (match[3]) {
      out.push(<Text key={k} style={{ fontStyle: "italic" }}>{inline(token.slice(1, -1), colors, k)}</Text>);
    } else if (match[4]) {
      out.push(<Text key={k} style={{ textDecorationLine: "line-through" }}>{inline(token.slice(2, -2), colors, k)}</Text>);
    } else {
      const link = match[5] ? /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token) : null;
      const label = link ? link[1] : token;
      const url = link ? link[2] : token;
      out.push(
        <Text key={k} style={{ color: colors.link }} onPress={() => /^https?:/.test(url) && void Linking.openURL(url)}>
          {label}
        </Text>,
      );
    }
    last = at + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function MarkdownView({ text, muted = false }: { text: string; muted?: boolean }) {
  const colors = useColors();
  const base = { fontFamily: font.regular, fontSize: 16, lineHeight: 26, color: muted ? colors.fgMuted : colors.fg };
  return (
    <View style={styles.root}>
      {parse(text).map((block, b) => {
        const key = `b${b}`;
        switch (block.kind) {
          case "p":
            return (
              <Text key={key} style={base} selectable>
                {inline(block.text, colors, key)}
              </Text>
            );
          case "h":
            return (
              <Text
                key={key}
                style={[base, { fontFamily: font.semibold, color: colors.fgStrong, fontSize: block.level === 1 ? 22 : block.level === 2 ? 19 : 17, lineHeight: block.level <= 2 ? 30 : 26, marginTop: 4 }]}
              >
                {inline(block.text, colors, key)}
              </Text>
            );
          case "code":
            return (
              <ScrollView key={key} horizontal style={[styles.code, { backgroundColor: colors.codeBg, borderColor: colors.hairline }]} contentContainerStyle={{ padding: 12 }}>
                <Text selectable style={{ fontFamily: font.mono, fontSize: 13, lineHeight: 20, color: colors.fg }}>
                  {block.text}
                </Text>
              </ScrollView>
            );
          case "quote":
            return (
              <View key={key} style={{ paddingLeft: 12 }}>
                <Text style={[base, { color: colors.fgMuted }]}>{inline(block.text, colors, key)}</Text>
              </View>
            );
          case "rule":
            return <View key={key} style={{ height: StyleSheet.hairlineWidth, backgroundColor: colors.edge, marginVertical: 6 }} />;
          case "table":
            return (
              <ScrollView key={key} horizontal style={[styles.code, { borderColor: colors.hairline }]} contentContainerStyle={{ padding: 12 }}>
                <Text selectable style={{ fontFamily: font.mono, fontSize: 13, lineHeight: 20, color: colors.fg }}>
                  {table(block.rows)}
                </Text>
              </ScrollView>
            );
          case "list":
            return (
              <View key={key} style={{ gap: 4 }}>
                {block.items.map((item, n) => (
                  <View key={n} style={{ flexDirection: "row", paddingLeft: item.depth * 16 }}>
                    <Text style={[base, { width: block.ordered ? 26 : 18, color: colors.fgMuted }]}>{block.ordered ? `${block.start + n}.` : "•"}</Text>
                    <Text style={[base, { flex: 1 }]} selectable>
                      {inline(item.text, colors, `${key}-${n}`)}
                    </Text>
                  </View>
                ))}
              </View>
            );
        }
      })}
    </View>
  );
}

function table(rows: string[][]): string {
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)));
  return rows.map((row, r) => row.map((cell, i) => cell.padEnd(widths[i])).join("  ") + (r === 0 && rows.length > 1 ? `\n${widths.map((w) => "─".repeat(w)).join("  ")}` : "")).join("\n");
}

export const Markdown = memo(MarkdownView);

const styles = StyleSheet.create({
  root: { gap: 12 },
  code: { borderRadius: 12, borderWidth: StyleSheet.hairlineWidth },
});
