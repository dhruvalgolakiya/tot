import clsx from "clsx";
import { ArrowRight } from "lucide-react";
import { ClaudeMark, OpenAIMark } from "../os/BrandMarks";

const BRAINS = [
  {
    name: "Claude",
    Mark: ClaudeMark,
    via: "Claude Code · your Pro or Max plan",
    models: "Opus 5.5, Sonnet 5.5",
    used: 92,
    mood: "Running on fumes",
  },
  { name: "ChatGPT", Mark: OpenAIMark, via: "Codex · your Plus or Pro plan", models: "GPT‑6", used: 34, mood: "Fresh as a daisy" },
];

const ROUTES: { ask: string; pick: string; note: string }[] = [
  { ask: "What's 15% of 84?", pick: "Sonnet 5.5", note: "fast" },
  { ask: "Why does checkout crash on Safari?", pick: "Opus 5.5 or GPT‑6", note: "deep" },
  { ask: "Think harder: redesign billing", pick: "The strongest model", note: "extra effort" },
  { ask: "Someone should check this diff", pick: "The other provider", note: "fresh eyes" },
];

/** Two brains, zero API keys: usage, and how TOT Auto picks a model. */
export function Brains() {
  return (
    <div className="space-y-6 px-5 py-5 sm:px-6">
      <div className="grid gap-3 @lg:grid-cols-2">
        {BRAINS.map((brain) => (
          <div key={brain.name} className="rounded-xl border border-hairline bg-fill-subtle p-4">
            <div className="flex items-baseline justify-between gap-2">
              <p className="flex items-center gap-2 text-base font-semibold text-fg-strong">
                <brain.Mark className="size-4.5" />
                {brain.name}
              </p>
              <p className="text-xs text-fg-subtle tabular-nums">{brain.used}% of this week</p>
            </div>
            <p className="mt-0.5 text-xs text-fg-subtle">{brain.via}</p>
            <div className="mt-3 h-2 overflow-hidden rounded-full bg-fill">
              <div
                className={clsx("h-full rounded-full", brain.used > 80 ? "bg-amber-400" : "bg-emerald-400")}
                style={{ width: `${brain.used}%` }}
              />
            </div>
            <p className="mt-2 text-ui text-fg-muted">
              {brain.models} · <span className="text-fg">{brain.mood}</span>
            </p>
          </div>
        ))}
      </div>
      <p className="text-sm leading-relaxed text-fg-muted">
        When Claude runs out of juice, ChatGPT takes the next shift until it resets, and the queue keeps moving. No API keys: both run on
        your own logins.
      </p>
      <div className="overflow-hidden rounded-xl border border-hairline">
        <div className="grid grid-cols-[1fr_auto] border-b border-hairline px-4 py-2 text-xs text-fg-subtle">
          <span>You say</span>
          <span>TOT Auto picks</span>
        </div>
        {ROUTES.map((route) => (
          <div key={route.ask} className="flex items-center gap-3 border-b border-hairline px-4 py-3 last:border-b-0">
            <p className="min-w-0 flex-1 text-sm text-fg">“{route.ask}”</p>
            <ArrowRight className="size-4 shrink-0 text-fg-faint" />
            <p className="w-32 shrink-0 text-right text-sm @md:w-40">
              <span className="block font-medium text-fg">{route.pick}</span>
              <span className="block text-xs text-fg-subtle">{route.note}</span>
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}
