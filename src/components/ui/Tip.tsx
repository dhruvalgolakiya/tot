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
          className="dark z-[60] max-w-72 rounded-md border border-edge bg-zinc-800 px-2 py-1 text-xs font-medium text-fg shadow-popover data-[state=closed]:animate-fade-out data-[state=delayed-open]:animate-fade-in"
        >
          {content}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}
