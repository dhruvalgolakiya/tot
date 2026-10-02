import { AppWindow, Brain, CalendarCheck, Newspaper } from "lucide-react";
import { sendMessage, useStore } from "../store";

const SUGGESTIONS = [
  { icon: AppWindow, label: "Build a landing page", text: "Build a landing page on your computer and send me the link" },
  { icon: Newspaper, label: "Research the news", text: "Research the latest AI agent news and summarize it" },
  { icon: Brain, label: "Save a memory", text: "Remember that I prefer TypeScript and short answers" },
  { icon: CalendarCheck, label: "Plan my week", text: "Plan my week around 3 deep-work blocks" },
];

/** Starter-prompt pill chips under the composer; clicking one sends the fuller prompt behind the short label. */
export function Suggestions() {
  const sending = useStore((s) => s.sending);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-center gap-2 px-3 sm:px-4">
      {SUGGESTIONS.map(({ icon: Icon, label, text }) => (
        <button
          key={text}
          type="button"
          disabled={sending}
          onClick={() => void sendMessage(text)}
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-edge px-3.5 text-sm text-fg-muted transition-colors hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-50"
        >
          <Icon className="size-4 shrink-0 text-fg-subtle" />
          {label}
        </button>
      ))}
    </div>
  );
}
