import type { ReactElement, ReactNode } from "react";
import { Tooltip } from "radix-ui";

type TipProps = {
  content: ReactNode;
  children: ReactElement;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
};

/** Tooltip around a single focusable child (which must forward props and ref). */
export function Tip({ content, children, side = "top", align = "center" }: TipProps) {
  if (content === null || content === undefined || content === "") return children;
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side={side}
          align={align}
          sideOffset={6}
          collisionPadding={8}
          className="dark z-[60] max-w-72 rounded-lg border border-white/10 bg-zinc-800 px-2.5 py-1.5 text-xs leading-relaxed text-zinc-100 shadow-xl shadow-shade/40 data-[state=closed]:animate-fade-out data-[state=delayed-open]:animate-fade-in"
        >
          {content}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
