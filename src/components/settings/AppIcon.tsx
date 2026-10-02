import { useState } from "react";
import clsx from "clsx";

type AppIconProps = {
  name: string;
  iconUrl: string | null;
  /** Tailwind size utility, e.g. "size-8". */
  size?: string;
  className?: string;
};

/** An app's icon; falls back to its first letter when there's no image or it fails to load. */
export function AppIcon({ name, iconUrl, size = "size-8", className }: AppIconProps) {
  const [failed, setFailed] = useState(false);
  const letter = name.trim().charAt(0).toUpperCase() || "?";

  if (!iconUrl || failed) {
    return (
      <div
        aria-hidden="true"
        className={clsx(size, "grid shrink-0 place-items-center rounded-lg bg-white/[0.08] text-xs font-semibold text-zinc-300", className)}
      >
        {letter}
      </div>
    );
  }

  return (
    <img
      src={iconUrl}
      alt=""
      className={clsx(size, "shrink-0 rounded-lg bg-white/[0.08] object-cover", className)}
      onError={() => setFailed(true)}
    />
  );
}
