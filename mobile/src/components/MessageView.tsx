import { memo, useState } from "react";
import { ActivityIndicator, Image, Pressable, StyleSheet, Text, View } from "react-native";
import type { Attachment, Message, MessagePart } from "@shared/types";
import { authHeaders, errorMessage } from "../lib/api";
import { useConnection } from "../lib/connection";
import { answerApproval } from "../lib/store";
import { font, type as typeScale, useColors } from "../theme";
import { Markdown } from "./Markdown";
import { TaskGroupCard } from "./tasks";
import { Button, Icon } from "./ui";

/**
 * One message, as the web app's chat shows it: the user's in a bubble; the agent's as prose, with each tool
 * step and its thinking as one quiet line (tap to open), notices as muted text, and approval cards inline.
 */
function MessageViewBase({ message, streaming }: { message: Message; streaming: boolean }) {
  const colors = useColors();
  if (message.role === "user") {
    // Photos show as thumbnails above the bubble; other files as a line in it.
    const images = message.parts.flatMap((p) => (p.type === "file" && IMAGE_TYPES.has(p.attachment.mimeType) ? [p.attachment] : []));
    const text = message.parts
      .map((p) => (p.type === "text" ? p.text : p.type === "file" && !IMAGE_TYPES.has(p.attachment.mimeType) ? `Attached: ${p.attachment.name}` : ""))
      .join("\n")
      .trim();
    if (message.auto) return <Text style={[typeScale.xs, { color: colors.fgSubtle, textAlign: "center", paddingVertical: 4 }]}>{text}</Text>;
    return (
      <View style={[styles.userRow, { gap: 6 }]}>
        {images.length ? (
          <View style={styles.images}>
            {images.map((image) => (
              <Photo key={image.id} attachment={image} />
            ))}
          </View>
        ) : null}
        {text ? (
          <View style={[styles.bubble, { backgroundColor: colors.bubble }]}>
            <Text selectable style={[typeScale.chat, { color: colors.fg }]}>
              {text}
            </Text>
          </View>
        ) : null}
      </View>
    );
  }
  const empty = message.parts.length === 0;
  return (
    <View style={styles.assistant}>
      {message.parts.map((part, index) => {
        // Tasks started together stack into one card, at the first of them (the rest are folded in).
        const run = taskRun(message.parts, index);
        if (run === null) return null;
        if (run.length) return <TaskGroupCard key={part.id} taskIds={run} />;
        return <PartView key={part.id} part={part} conversationId={message.conversationId} />;
      })}
      {streaming && empty ? <Thinking label="Thinking" /> : null}
      {message.error && message.status === "error" ? (
        <Text style={[typeScale.sm, { color: colors.danger }]}>{message.error}</Text>
      ) : null}
      {message.status === "stopped" ? <Text style={[typeScale.xs, { color: colors.fgSubtle }]}>Stopped</Text> : null}
    </View>
  );
}

export const MessageView = memo(MessageViewBase);

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** A sent photo, fetched from the TOT with this phone's sign-in (its URL is an /api/ path there). */
function Photo({ attachment }: { attachment: Attachment }) {
  const colors = useColors();
  const base = useConnection((s) => s.url);
  return (
    <Image
      accessibilityLabel={attachment.name}
      source={{ uri: `${base ?? ""}${attachment.url}`, headers: authHeaders() }}
      style={[styles.photo, { backgroundColor: colors.fill }]}
      resizeMode="cover"
    />
  );
}

/** At a run of task cards' first part: the run's task ids; at its other parts: null; for any other part: []. */
function taskRun(parts: MessagePart[], index: number): string[] | null {
  if (parts[index]?.type !== "task") return [];
  if (parts[index - 1]?.type === "task") return null;
  const ids: string[] = [];
  for (let i = index; parts[i]?.type === "task"; i++) ids.push((parts[i] as Extract<MessagePart, { type: "task" }>).taskId);
  return ids;
}

function PartView({ part, conversationId }: { part: MessagePart; conversationId: string }) {
  const colors = useColors();
  switch (part.type) {
    case "text":
      return part.text ? <Markdown text={part.text} /> : null;
    case "reasoning":
      return (
        <Expandable title={part.durationMs ? `Thought for ${Math.max(1, Math.round(part.durationMs / 1000))}s` : "Thinking"} icon="clock" body={part.text} />
      );
    case "tool":
      return (
        <Expandable
          title={part.title || part.name}
          icon={part.status === "error" || part.isError ? "alert-circle" : part.status === "running" ? undefined : "check"}
          running={part.status === "running"}
          danger={part.status === "error" || part.isError}
          body={[part.input !== undefined ? formatInput(part.input) : "", part.output ?? ""].filter(Boolean).join("\n\n")}
          mono
        />
      );
    case "notice":
      return (
        <Text style={[typeScale.ui, { color: part.kind === "warning" ? colors.warning : colors.fgSubtle }]}>{part.text}</Text>
      );
    case "file":
      return (
        <View style={styles.line}>
          <Icon name="paperclip" size={13} color={colors.fgSubtle} />
          <Text style={[typeScale.ui, { color: colors.fgMuted }]}>{part.attachment.name}</Text>
        </View>
      );
    case "task":
      return <TaskGroupCard taskIds={[part.taskId]} />;
    case "approval":
      return <ApprovalCard part={part} conversationId={conversationId} />;
  }
}

function formatInput(input: unknown): string {
  if (typeof input === "string") return input;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return String(input);
  }
}

/** A tool step or the agent's thinking: one muted line, opened with a tap. */
function Expandable({ title, body, icon, running, danger, mono }: { title: string; body: string; icon?: Parameters<typeof Icon>[0]["name"]; running?: boolean; danger?: boolean; mono?: boolean }) {
  const colors = useColors();
  const [open, setOpen] = useState(false);
  const color = danger ? colors.danger : colors.fgSubtle;
  return (
    <View>
      <Pressable onPress={() => body && setOpen(!open)} hitSlop={6} style={styles.line}>
        {running ? <ActivityIndicator size="small" color={colors.fgSubtle} style={{ transform: [{ scale: 0.7 }] }} /> : icon ? <Icon name={icon} size={13} color={color} /> : null}
        <Text numberOfLines={1} style={[typeScale.ui, { color, flex: 1 }]}>
          {title}
        </Text>
        {body ? <Icon name={open ? "chevron-up" : "chevron-down"} size={13} color={colors.fgFaint} /> : null}
      </Pressable>
      {open ? (
        <Text selectable numberOfLines={40} style={[mono ? { fontFamily: font.mono, fontSize: 12, lineHeight: 18 } : typeScale.ui, { color: colors.fgMuted, marginTop: 6, marginLeft: 21 }]}>
          {body.length > 4000 ? `${body.slice(0, 4000)}…` : body}
        </Text>
      ) : null}
    </View>
  );
}

function Thinking({ label }: { label: string }) {
  const colors = useColors();
  return (
    <View style={styles.line}>
      <ActivityIndicator size="small" color={colors.fgSubtle} style={{ transform: [{ scale: 0.7 }] }} />
      <Text style={[typeScale.ui, { color: colors.fgSubtle }]}>{label}…</Text>
    </View>
  );
}

function ApprovalCard({ part, conversationId }: { part: Extract<MessagePart, { type: "approval" }>; conversationId: string }) {
  const colors = useColors();
  const [busy, setBusy] = useState<"accept" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const answer = async (decision: "accept" | "decline") => {
    setBusy(decision);
    setError(null);
    try {
      await answerApproval(conversationId, part, decision);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const pending = part.status === "pending";
  const done = { accepted: "Approved", declined: "Declined", expired: "Expired", pending: "" }[part.status];
  const yes = part.lead ? (part.lead.action === "discard" ? "Discard" : part.lead.action === "push" ? "Push" : "Land it") : part.kind === "url" ? "Done" : "Approve";
  return (
    <View style={[styles.card, { borderColor: colors.edge }]}>
      <Text style={[typeScale.xs, { fontFamily: font.medium, color: colors.fgSubtle }]}>{part.source}</Text>
      <Text style={[typeScale.body, { color: colors.fg }]}>{part.message}</Text>
      {part.kind === "url" && part.url ? <Text style={[typeScale.ui, { color: colors.link }]}>{part.url}</Text> : null}
      {part.kind === "form" && pending ? (
        <Text style={[typeScale.ui, { color: colors.fgSubtle }]}>This asks for a few fields. Answer it in TOT on your computer for now.</Text>
      ) : null}
      {pending ? (
        <View style={styles.cardActions}>
          <Button label="Decline" variant="secondary" onPress={() => void answer("decline")} busy={busy === "decline"} disabled={busy !== null} style={{ height: 36 }} />
          <Button label={yes} onPress={() => void answer("accept")} busy={busy === "accept"} disabled={busy !== null || part.kind === "form"} style={{ height: 36 }} />
        </View>
      ) : (
        <Text style={[typeScale.ui, { fontFamily: font.medium, color: part.status === "accepted" ? colors.success : colors.fgSubtle }]}>{done}</Text>
      )}
      {error ? <Text style={[typeScale.ui, { color: colors.danger }]}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  images: { flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: 6, maxWidth: "85%" },
  photo: { width: 120, height: 120, borderRadius: 14 },
  userRow: { alignItems: "flex-end" },
  bubble: { maxWidth: "85%", borderRadius: 22, paddingHorizontal: 16, paddingVertical: 10 },
  assistant: { gap: 12 },
  line: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 22 },
  card: { borderWidth: StyleSheet.hairlineWidth * 2, borderRadius: 16, padding: 14, gap: 8 },
  cardActions: { flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 4 },
});
