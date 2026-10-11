import { memo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import type { Message, MessagePart } from "@shared/types";
import { errorMessage } from "../lib/api";
import { answerApproval, useStore } from "../lib/store";
import { font, type as typeScale, useColors } from "../theme";
import { Markdown } from "./Markdown";
import { Button, Icon } from "./ui";

/**
 * One message, as the web app's chat shows it: the user's in a bubble; the agent's as prose, with each tool
 * step and its thinking as one quiet line (tap to open), notices as muted text, and approval cards inline.
 */
function MessageViewBase({ message, streaming }: { message: Message; streaming: boolean }) {
  const colors = useColors();
  if (message.role === "user") {
    const text = message.parts.map((p) => (p.type === "text" ? p.text : p.type === "file" ? `Attached: ${p.attachment.name}` : "")).join("\n").trim();
    if (message.auto) return <Text style={[typeScale.xs, { color: colors.fgSubtle, textAlign: "center", paddingVertical: 4 }]}>{text}</Text>;
    return (
      <View style={styles.userRow}>
        <View style={[styles.bubble, { backgroundColor: colors.bubble }]}>
          <Text selectable style={[typeScale.chat, { color: colors.fg }]}>
            {text}
          </Text>
        </View>
      </View>
    );
  }
  const empty = message.parts.length === 0;
  return (
    <View style={styles.assistant}>
      {message.parts.map((part) => (
        <PartView key={part.id} part={part} conversationId={message.conversationId} />
      ))}
      {streaming && empty ? <Thinking label="Thinking" /> : null}
      {message.error && message.status === "error" ? (
        <Text style={[typeScale.sm, { color: colors.danger }]}>{message.error}</Text>
      ) : null}
      {message.status === "stopped" ? <Text style={[typeScale.xs, { color: colors.fgSubtle }]}>Stopped</Text> : null}
    </View>
  );
}

export const MessageView = memo(MessageViewBase);

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
      return <TaskLine taskId={part.taskId} />;
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

const TASK_STATUS: Record<string, string> = {
  queued: "Queued",
  running: "Running",
  "needs-input": "Needs you",
  paused: "Paused",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
  interrupted: "Interrupted",
};

/** A task started from this chat. Its full card (steer, pause, land) comes with tasks in M2. */
function TaskLine({ taskId }: { taskId: string }) {
  const colors = useColors();
  const task = useStore((s) => s.conversations.find((c) => c.id === taskId));
  return (
    <View style={[styles.task, { borderColor: colors.hairline }]}>
      <Icon name="layers" size={14} color={colors.fgSubtle} />
      <Text numberOfLines={1} style={[typeScale.ui, { color: colors.fg, flex: 1 }]}>
        {task?.title || "Task"}
      </Text>
      <Text style={[typeScale.xs, { color: colors.fgSubtle }]}>{task?.task ? TASK_STATUS[task.task.status] : ""}</Text>
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
  userRow: { alignItems: "flex-end" },
  bubble: { maxWidth: "85%", borderRadius: 22, paddingHorizontal: 16, paddingVertical: 10 },
  assistant: { gap: 12 },
  line: { flexDirection: "row", alignItems: "center", gap: 8, minHeight: 22 },
  task: { flexDirection: "row", alignItems: "center", gap: 8, borderWidth: StyleSheet.hairlineWidth * 2, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10 },
  card: { borderWidth: StyleSheet.hairlineWidth * 2, borderRadius: 16, padding: 14, gap: 8 },
  cardActions: { flexDirection: "row", justifyContent: "flex-end", gap: 8, marginTop: 4 },
});
