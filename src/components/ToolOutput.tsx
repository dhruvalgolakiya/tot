import clsx from "clsx";

type ToolOutputProps = {
  label: string;
  text: string;
  error?: boolean;
};

/** Labeled monospace box with its own scroll (input or output of a tool call). */
export function ToolOutput({ label, text, error = false }: ToolOutputProps) {
  return (
    <div>
      <div className={clsx("mb-1 text-2xs font-medium tracking-wide uppercase", error ? "text-danger" : "text-fg-subtle")}>
        {label}
      </div>
      <pre
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
