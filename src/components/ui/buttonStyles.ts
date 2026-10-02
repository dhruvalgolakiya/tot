import clsx from "clsx";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-zinc-100 text-zinc-950 hover:bg-white",
  secondary: "border border-white/10 bg-white/[0.04] text-zinc-100 hover:bg-white/[0.08]",
  ghost: "text-zinc-300 hover:bg-white/[0.06] hover:text-zinc-100",
  danger: "bg-red-500/90 text-white hover:bg-red-500",
};

const SIZES: Record<ButtonSize, string> = {
  sm: "h-8 gap-1.5 rounded-lg px-3 text-[13px] [&_svg]:size-3.5",
  md: "h-9 gap-2 rounded-lg px-3.5 text-sm [&_svg]:size-4",
};

/** Shared by <Button> and links styled as buttons. */
export function buttonClass(variant: ButtonVariant = "secondary", size: ButtonSize = "md", className?: string) {
  return clsx(
    "inline-flex shrink-0 items-center justify-center font-medium whitespace-nowrap transition-colors disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0",
    VARIANTS[variant],
    SIZES[size],
    className,
  );
}
