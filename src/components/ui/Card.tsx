import type { ComponentProps } from "react";
import clsx from "clsx";

export type CardPadding = "none" | "sm" | "md";

const PADDING: Record<CardPadding, string> = { none: "", sm: "p-3", md: "p-4" };

type CardStyle = {
  /** sm = 12px (dense list cards), md = 16px (default), none = sections handle their own padding. */
  padding?: CardPadding;
  /** The whole card is clickable (a <button> or <a>): adds hover and press states. */
  interactive?: boolean;
  className?: string;
};

/**
 * An in-flow container: hairline border on a faint fill, 12px radius, no shadow. For clickable cards,
 * lists of cards rendered as <li>, or forms, put `cardClass()` on your own element.
 * Split a card into sections with `border-t border-hairline` (sections keep the card's padding).
 */
export function cardClass({ padding = "md", interactive = false, className }: CardStyle = {}) {
  return clsx(
    "rounded-xl border border-hairline bg-fill-subtle",
    PADDING[padding],
    interactive && "text-left transition-colors hover:border-edge hover:bg-hover active:bg-selected",
    className,
  );
}

type CardProps = ComponentProps<"div"> & Omit<CardStyle, "className">;

export function Card({ padding, interactive, className, ...props }: CardProps) {
  return <div className={cardClass({ padding, interactive, className })} {...props} />;
}
