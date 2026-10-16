import clsx from "clsx";
import { initials } from "../../lib/personas";

type PersonaAvatarProps = {
  name: string;
  /** The persona's picture; without one, its initials. */
  url?: string | null;
  /** Tailwind size utility, e.g. "size-10". */
  size?: string;
  className?: string;
};

/** The persona's picture in a circle, or a flat initials circle like AppIcon's letter fallback. */
export function PersonaAvatar({ name, url, size = "size-9", className }: PersonaAvatarProps) {
  if (url) {
    return <img src={url} alt="" aria-hidden="true" className={clsx(size, "shrink-0 rounded-full bg-fill object-cover", className)} />;
  }
  return (
    <div
      aria-hidden="true"
      className={clsx(size, "grid shrink-0 place-items-center rounded-full bg-fill text-xs font-semibold text-fg-muted", className)}
    >
      {initials(name)}
    </div>
  );
}
