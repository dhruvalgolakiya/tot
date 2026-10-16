import clsx from "clsx";
import { Mascot } from "../../src/components/mascot";
import { crew } from "../crew";

const RULES = [
  "merge your pull request",
  "push to main",
  "email anyone without asking",
  "touch your Mac's files",
  "talk to strangers (no password, no entry)",
  "blab your secrets",
];

/** The house rules: things TOT will never do, on a yellow sticky note. */
export function StickyNote({ className }: { className?: string }) {
  return (
    <div className={clsx("sticky-note relative w-60 px-5 pt-5 pb-3.5 text-fixed-black", className)}>
      <span aria-hidden="true" className="absolute -top-2.5 left-1/2 h-5 w-20 -translate-x-1/2 rotate-2 bg-[rgb(255_255_255/0.55)] shadow-sm" />
      <p className="font-hand text-2xl leading-none font-bold">House rules</p>
      <p className="font-hand mt-1 text-lg leading-tight opacity-80">TOT will never:</p>
      <ol className="font-hand mt-1 text-lg leading-snug">
        {RULES.map((rule, index) => (
          <li key={rule}>
            {index + 1}. {rule}
          </li>
        ))}
      </ol>
      <div className="mt-3 flex items-center justify-end gap-1">
        <span className="font-hand mr-1 text-lg opacity-70">— the team</span>
        <Mascot spec={crew.tot.spec} state="idle" size={24} />
        <Mascot spec={crew.ribbit.spec} state="sleeping" size={24} />
      </div>
    </div>
  );
}

/** The same note as an app (the phone's House rules icon). */
export function Rules() {
  return (
    <div className="grid min-h-full place-items-center p-8">
      <StickyNote className="-rotate-2" />
    </div>
  );
}
