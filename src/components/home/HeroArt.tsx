import { useState } from "react";
import clsx from "clsx";
import { useResolvedTheme } from "../../lib/theme";

/** The scenes in public/hero/: night for dark mode, dawn for light mode. */
const SCENES = { dark: "/hero/night.webp", light: "/hero/dawn.webp" } as const;

/**
 * The pixel-art scene behind Home's title, in the app and on the public site. It fills its (positioned) parent
 * and fades out at the bottom. Until a scene's image exists, or if it fails to load, a dithered sky stands in.
 */
export function HeroArt({ className }: { className?: string }) {
  const theme = useResolvedTheme();
  const src = SCENES[theme];
  const [failed, setFailed] = useState<string | null>(null);

  return (
    <div aria-hidden="true" className={clsx("hero-art pointer-events-none absolute inset-0 overflow-hidden", className)}>
      {failed === src ? (
        <div className="hero-fallback size-full" />
      ) : (
        <img key={src} src={src} alt="" decoding="async" onError={() => setFailed(src)} className="size-full object-cover" />
      )}
    </div>
  );
}
