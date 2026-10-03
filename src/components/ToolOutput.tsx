import { useLayoutEffect, useRef } from "react";
import clsx from "clsx";

type ToolOutputProps = {
  label: string;
  text: string;
  error?: boolean;
  /** Open scrolled to the end, for output whose last lines matter most (a failing command). */
  startAtEnd?: boolean;
};

/** Labeled monospace box with its own scroll (input or output of a tool call). */
export function ToolOutput({ label, text, error = false, startAtEnd = false }: ToolOutputProps) {
  const ref = useRef<HTMLPreElement>(null);
  useLayoutEffect(() => {
    if (startAtEnd && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [startAtEnd, text]);

  return (
    <div>
      <div className={clsx("mb-1 text-2xs font-medium tracking-wide uppercase", error ? "text-danger" : "text-fg-subtle")}>
        {label}
      </div>
      <pre
        ref={ref}
        className={clsx(
          "dark max-h-72 overflow-auto rounded-lg bg-zinc-950 px-3 py-2.5 font-mono text-xs leading-relaxed [overflow-wrap:anywhere] whitespace-pre-wrap",
          error ? "text-red-300" : "text-zinc-300",
        )}
      >
        {text}
      </pre>
    </div>
  );
}
