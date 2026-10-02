import clsx from "clsx";
import { AppWindow, Brain, CalendarCheck, Newspaper } from "lucide-react";
import { sendMessage, useStore } from "../store";

const SUGGESTIONS = [
  { icon: AppWindow, text: "Build a landing page on your computer and send me the link" },
  { icon: Newspaper, text: "Research the latest AI agent news and summarize it" },
  { icon: Brain, text: "Remember that I prefer TypeScript and short answers" },
  { icon: CalendarCheck, text: "Plan my week around 3 deep-work blocks" },
];

/** Starter prompts on the new-chat screen; clicking one sends it. */
export function Suggestions() {
  const sending = useStore((s) => s.sending);

  return (
    <div className="mx-auto grid w-full max-w-3xl grid-cols-1 gap-2 px-3 sm:grid-cols-2 sm:px-4">
      {SUGGESTIONS.map(({ icon: Icon, text }, index) => (
        <button
          key={text}
          type="button"
          disabled={sending}
          onClick={() => void sendMessage(text)}
          className={clsx(
            "flex min-w-0 items-start gap-3 rounded-2xl bg-white/[0.025] px-4 py-3 text-left text-sm leading-snug text-zinc-400 transition-all hover:-translate-y-0.5 hover:bg-white/[0.06] hover:text-zinc-100 disabled:pointer-events-none disabled:opacity-50",
            index >= 2 && "hidden sm:flex",
          )}
        >
          <Icon className="mt-px size-4 shrink-0 text-zinc-500" />
          <span className="min-w-0">{text}</span>
        </button>
      ))}
    </div>
  );
}
