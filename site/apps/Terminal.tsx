import { useEffect, useState } from "react";
import clsx from "clsx";
import { Check, Copy } from "lucide-react";
import { useReducedMotion } from "../ui";

/** What actually gets copied. */
const SETUP = `claude          # then type /login
codex login
npm install
npm run dev
open http://localhost:5173`;

type Line = { kind: "cmd" | "out" | "ok" | "note"; text: string };

/** What plays on screen: the same steps, with a little commentary. */
const SCRIPT: Line[] = [
  { kind: "note", text: "# Log in once, to either or both" },
  { kind: "cmd", text: "claude" },
  { kind: "out", text: "  > /login" },
  { kind: "ok", text: "  ✓ Logged in with your Claude plan" },
  { kind: "cmd", text: "codex login" },
  { kind: "ok", text: "  ✓ Logged in with ChatGPT" },
  { kind: "note", text: "# Start TOT (needs Node 22.13 or newer)" },
  { kind: "cmd", text: "npm install" },
  { kind: "out", text: "  added 412 packages, and 0 API keys" },
  { kind: "cmd", text: "npm run dev" },
  { kind: "ok", text: "  TOT is up → http://localhost:5173" },
  { kind: "out", text: "  Tot says hi. Ribbit is asleep." },
  { kind: "note", text: "# Optional: a boat.dev key gives every agent a cloud computer" },
];

/** Install steps as a terminal that types itself out. */
export function Terminal() {
  const reduced = useReducedMotion();
  // How many lines are fully shown, and how much of the next command is typed.
  const [shown, setShown] = useState(reduced ? SCRIPT.length : 0);
  const [typed, setTyped] = useState(0);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (shown >= SCRIPT.length) return;
    const line = SCRIPT[shown]!;
    if (line.kind === "cmd" && typed < line.text.length) {
      const timer = setTimeout(() => setTyped((count) => count + 1), 45);
      return () => clearTimeout(timer);
    }
    const timer = setTimeout(
      () => {
        setShown((count) => count + 1);
        setTyped(0);
      },
      line.kind === "cmd" ? 380 : 260,
    );
    return () => clearTimeout(timer);
  }, [shown, typed]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(SETUP);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // No clipboard access (e.g. plain http on another device): the text is still selectable.
    }
  }

  const current = SCRIPT[shown];
  return (
    <div className="relative min-h-full bg-panel p-5 font-mono text-[13px] leading-relaxed">
      <button
        type="button"
        onClick={() => void copy()}
        className="absolute top-3 right-3 inline-flex h-7 items-center gap-1.5 rounded-full border border-edge px-2.5 font-sans text-xs font-medium text-fg-muted transition-colors hover:bg-hover hover:text-fg"
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        {copied ? "Copied" : "Copy commands"}
      </button>
      <p className="mb-3 text-fg-subtle">Last login: today on ttys001</p>
      {SCRIPT.slice(0, shown).map((line, index) => (
        <TerminalLine key={index} line={line} />
      ))}
      {current?.kind === "cmd" ? (
        <p className="text-fg">
          <Prompt />
          {current.text.slice(0, typed)}
          <Caret />
        </p>
      ) : (
        <p className="text-fg">
          <Prompt />
          <Caret />
        </p>
      )}
    </div>
  );
}

function TerminalLine({ line }: { line: Line }) {
  if (line.kind === "cmd") {
    return (
      <p className="text-fg">
        <Prompt />
        {line.text}
      </p>
    );
  }
  return (
    <p
      className={clsx(
        "whitespace-pre-wrap",
        line.kind === "ok" && "text-success",
        line.kind === "out" && "text-fg-muted",
        line.kind === "note" && "mt-2 text-fg-subtle",
      )}
    >
      {line.text}
    </p>
  );
}

function Prompt() {
  return <span className="text-accent-text">~/tot % </span>;
}

function Caret() {
  return <span aria-hidden="true" className="ml-px inline-block h-4 w-2 translate-y-0.5 animate-pulse bg-fg-muted" />;
}
