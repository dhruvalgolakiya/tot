import { Mascot } from "../../src/components/mascot";
import { crew } from "../crew";
import { useOs } from "../os/context";
import { pillClass } from "../ui";

/** The pitch, as the README on Tot's desktop (and the top widget on the phone). */
export function Readme() {
  const { open, layout } = useOs();
  const phone = layout === "phone";
  return (
    <div className="px-6 pt-6 pb-7 sm:px-7">
      <div aria-hidden="true" className="mb-4 flex items-end gap-1">
        <Mascot spec={crew.tot.spec} state="speaking" size={54} />
        <Mascot spec={crew.mochi.spec} state="idle" size={40} />
        <Mascot spec={crew.bolt.spec} state="thinking" size={40} />
      </div>
      <h1 className="font-display text-[40px] leading-[1.02] font-semibold tracking-tight text-balance text-fg-strong">
        Meet your tiny AI team.
      </h1>
      <p className="mt-2 font-display text-2xl leading-tight text-fg-subtle">They have computers. And hats.</p>
      <p className="mt-5 text-[15px] leading-relaxed text-fg-muted">
        {phone ? "This is Tot's home screen, if Tot had a phone. " : "You're looking at Tot's computer. "}
        Every agent on TOT gets a real one, plus a memory that sticks and a face you'll get weirdly attached to. They run on the Claude and
        ChatGPT plans you already pay for. No API keys.
      </p>
      <p className="mt-3 text-[15px] leading-relaxed text-fg-muted">
        {phone ? "Tap around: every app here opens." : "Poke around: everything on this desktop opens."} Nothing here will merge your pull
        request.
      </p>
      <div className="mt-6 flex flex-wrap gap-2">
        <button type="button" onClick={() => open("terminal")} className={pillClass("primary")}>
          Install TOT
        </button>
        <button type="button" onClick={() => open("features")} className={pillClass()}>
          What's inside
        </button>
        <a href="/docs" className="inline-flex h-9 items-center px-2 text-sm font-medium text-fg-muted transition-colors hover:text-fg max-sm:px-0">
          Read the docs
        </a>
      </div>
      <p className="mt-5 text-xs text-fg-subtle">Claude Pro or Max · ChatGPT Plus or Pro · your Mac, and your phone</p>
    </div>
  );
}
