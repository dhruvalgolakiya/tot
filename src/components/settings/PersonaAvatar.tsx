import clsx from "clsx";
import { initials } from "../../lib/personas";

type PersonaAvatarProps = {
  name: string;
  /** Tailwind size utility, e.g. "size-10". */
  size?: string;
  className?: string;
};

/** A persona has no photo — just a flat initials circle, like AppIcon's letter fallback. */
export function PersonaAvatar({ name, size = "size-9", className }: PersonaAvatarProps) {
  return (
    <div
      aria-hidden="true"
      className={clsx(size, "grid shrink-0 place-items-center rounded-full bg-fill text-xs font-semibold text-fg-muted", className)}
    >
      {initials(name)}
    </div>
  );
}
