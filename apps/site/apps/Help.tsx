import { useRef, useState } from "react";
import clsx from "clsx";
import { ArrowUp } from "lucide-react";
import { Mascot } from "../../src/components/mascot";
import { crew } from "../crew";
import { createJump, scrollToChild } from "../os/jump";

export const FAQ: { q: string; a: string }[] = [
  {
    q: "Do I need API keys?",
    a: "Nope. I run on your Claude Pro or Max and ChatGPT Plus or Pro logins, the same way Claude Code and Codex do. Keys only come in if you host TOT for other people.",
  },
  {
    q: "What does it cost?",
    a: "The subscriptions you already have. Cloud computers are optional: boat.dev bills per second while a VM runs. Without one, I work in a sandboxed folder on your Mac.",
  },
  {
    q: "Can I leave you running overnight?",
    a: "Please do. Tasks queue up, switch providers when one hits its limit, survive restarts and report everything back. I just won't merge, push to main or email anyone without you.",
  },
  {
    q: "Claude or ChatGPT?",
    a: "Both, if you have both. I pick per job, and reviews run on the other one, so code gets a second opinion from a different model.",
  },
  { q: "Why the mascots?", a: "A spinner can't look guilty when the tests fail." },
  {
    q: "Can I use it from my phone?",
    a: "Yes. In Settings → Devices, choose a password and scan the QR code with your phone. It works on your Wi-Fi, or from anywhere with Tailscale.",
  },
];

/** The FAQ, as a conversation with Tot. */
/** Opens Help at one question (from the launcher). */
export const questionJump = createJump();

export function Help() {
  const thread = useRef<HTMLDivElement>(null);
  const [flash, setFlash] = useState<string | null>(null);
  questionJump.useJump((question) => {
    const index = FAQ.findIndex(({ q }) => q === question);
    const pair = thread.current?.querySelector<HTMLElement>(`[data-question="${index}"]`);
    if (!pair) return;
    scrollToChild(pair);
    setFlash(question);
    setTimeout(() => setFlash((current) => (current === question ? null : current)), 1600);
  });
  return (
    <div className="flex min-h-full flex-col">
      <div ref={thread} className="flex-1 space-y-3 px-3 py-5">
        <p className="pb-2 text-center text-xs text-fg-subtle">Today · Tot usually replies instantly</p>
        {FAQ.map(({ q, a }, index) => (
          <div
            key={q}
            data-question={index}
            className={clsx("space-y-3 rounded-2xl px-2 py-1 transition-colors duration-500", flash === q && "bg-accent-soft")}
          >
            <div className="flex justify-end">
              <p className="max-w-[85%] rounded-3xl bg-bubble px-4 py-2 text-[15px] text-fg">{q}</p>
            </div>
            <div className="flex gap-2.5">
              <span className="shrink-0 pt-0.5">
                <Mascot spec={crew.tot.spec} state="speaking" size={28} />
              </span>
              <p className="min-w-0 text-[15px] leading-relaxed text-fg">{a}</p>
            </div>
          </div>
        ))}
      </div>
      <div className="sticky bottom-0 border-t border-hairline bg-elevated/90 px-4 py-3 backdrop-blur">
        <div className="flex items-center gap-2 rounded-full border border-edge bg-canvas py-1.5 pr-1.5 pl-4">
          <p className="min-w-0 flex-1 truncate text-sm text-fg-subtle">Ask Tot anything (this one's just a demo)</p>
          <span className="grid size-8 place-items-center rounded-full bg-fill-strong text-fg-faint">
            <ArrowUp className="size-4" strokeWidth={2.25} />
          </span>
        </div>
      </div>
    </div>
  );
}
