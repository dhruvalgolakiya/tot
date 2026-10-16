import type { ComponentProps } from "react";
import clsx from "clsx";

export type CardPadding = "none" | "sm" | "md";
export type CardRadius = "xl" | "2xl";

const PADDING: Record<CardPadding, string> = { none: "", sm: "p-3", md: "p-4" };
const RADIUS: Record<CardRadius, string> = { xl: "rounded-xl", "2xl": "rounded-2xl" };

type CardStyle = {
  /** sm = 12px (dense list cards), md = 16px (default), none = sections handle their own padding. */
  padding?: CardPadding;
  /** 12px (default) or 16px — pass "2xl" instead of adding a `rounded-*` class in `className`, which
   *  would conflict with the one baked in here (same-layer Tailwind utilities, order isn't source order). */
  radius?: CardRadius;
  /** The whole card is clickable (a <button> or <a>): adds hover and press states. */
  interactive?: boolean;
  className?: string;
};

/**
 * An in-flow container: a flat hairline border, 12px radius, no fill and no shadow — ChatGPT/Codex settings
 * read as flat sections rather than boxed cards. For clickable cards, lists of cards rendered as <li>, or
 * forms, put `cardClass()` on your own element. Split a card into sections with `border-t border-hairline`
 * (sections keep the card's padding). Pass `bg-fill-subtle` in `className` for the rare card that wants a fill
 * (e.g. the apps catalog grid).
 */
export function cardClass({ padding = "md", radius = "xl", interactive = false, className }: CardStyle = {}) {
  return clsx(
    RADIUS[radius],
    "border border-hairline",
    PADDING[padding],
    interactive && "text-left transition-colors hover:border-edge hover:bg-hover active:bg-selected",
    className,
  );
}

type CardProps = ComponentProps<"div"> & Omit<CardStyle, "className">;

export function Card({ padding, radius, interactive, className, ...props }: CardProps) {
  return <div className={cardClass({ padding, radius, interactive, className })} {...props} />;
}
