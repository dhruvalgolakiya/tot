import { Fragment } from "react";

/** Plain text where `backticks` mark inline code. */
export function TickText({ text }: { text: string }) {
  const segments = text.split("`");
  if (segments.length < 3 || segments.length % 2 === 0) return <>{text}</>;
  return (
    <>
      {segments.map((segment, index) =>
        index % 2 === 1 ? (
          <code key={index} className="rounded bg-white/[0.07] px-1 py-px font-mono text-[0.9em] text-zinc-200">
            {segment}
          </code>
        ) : (
          <Fragment key={index}>{segment}</Fragment>
        ),
      )}
    </>
  );
}
