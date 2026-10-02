import clsx from "clsx";

/**
 * primary: the one main action in an area (monochrome, not the agent accent).
 * secondary: bordered, for other actions beside a primary or on their own.
 * ghost: low-emphasis actions (Cancel, toolbar text buttons).
 * danger: confirms a destructive action (in a confirm dialog or inline confirm).
 * ghost-danger: starts a destructive action (Delete agent, Disconnect) without shouting.
 */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "ghost-danger";
/** sm = 32px (in cards, rows, inline confirms), md = 36px (forms, dialogs, page actions). */
export type ButtonSize = "sm" | "md";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-fg text-canvas hover:bg-fg/90 active:bg-fg/80",
  secondary: "border border-edge bg-fill-subtle text-fg hover:border-edge-strong hover:bg-hover active:bg-selected",
  ghost: "text-fg-muted hover:bg-hover hover:text-fg active:bg-selected",
  danger: "bg-danger-solid text-fixed-white hover:bg-danger-solid/90 active:bg-danger-solid/80",
  "ghost-danger": "text-danger hover:bg-danger-soft active:bg-danger-soft",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-8 gap-1.5 rounded-lg px-3 text-ui [&_svg]:size-3.5",
  md: "h-9 gap-2 rounded-lg px-3.5 text-sm [&_svg]:size-4",
};

/** Shared by <Button> and links styled as buttons. */
export function buttonClass(variant: ButtonVariant = "secondary", size: ButtonSize = "md", className?: string) {
  return clsx(
    "inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap transition-colors select-none",
    "disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&_svg]:shrink-0",
    VARIANTS[variant],
    SIZES[size],
    className,
  );
}
