import { ArrowUp } from "lucide-react";
import { Mascot } from "../../src/components/mascot";
import { crew } from "../crew";

const FAQ: { q: string; a: string }[] = [
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
    a: "Yes. Set an access token and open it on your Wi-Fi, or from anywhere through an HTTPS tunnel. Voice input works over HTTPS.",
  },
];

/** The FAQ, as a conversation with Tot. */
export function Help() {
  return (
    <div className="flex min-h-full flex-col">
      <div className="flex-1 space-y-5 px-5 py-5">
        <p className="text-center text-xs text-fg-subtle">Today · Tot usually replies instantly</p>
        {FAQ.map(({ q, a }) => (
          <div key={q} className="space-y-3">
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
