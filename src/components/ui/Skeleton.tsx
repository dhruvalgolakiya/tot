import type { ComponentProps } from "react";
import clsx from "clsx";

/**
 * A pulsing placeholder block. Size it with classes that match the content it stands in for
 * (`h-3.5 w-3/5` for a line of text, `h-16 rounded-xl` for a card). Wrap a group of skeletons in an
 * element with `aria-busy="true"` and an `aria-label` such as "Loading memories".
 */
export function Skeleton({ className, ...props }: ComponentProps<"div">) {
  return <div aria-hidden="true" className={clsx("animate-pulse rounded-md bg-fill", className)} {...props} />;
}
