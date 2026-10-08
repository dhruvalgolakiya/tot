import { useState, type CSSProperties } from "react";
import clsx from "clsx";
import type { AgentIsland } from "@shared/types";
import { useResolvedTheme } from "../../lib/theme";

/** The scenes in public/hero/: night for dark mode, dawn for light mode. */
const SCENES = { dark: "/hero/night.webp", light: "/hero/dawn.webp" } as const;

/**
 * Where each island sits in both scenes (they share a composition), as a % of the image, and how high in the frame
 * it goes (`top`, % of the frame's height). The greenhouse hangs below the others: lifted as high, it would push them
 * up under the header.
 */
const ISLAND_SPOTS: Record<AgentIsland, { x: number; y: number; top: number }> = {
  workshop: { x: 11, y: 49, top: 42 },
  observatory: { x: 19, y: 44, top: 42 },
  tower: { x: 26.5, y: 46, top: 42 },
  greenhouse: { x: 21, y: 57, top: 50 },
};

/** How far the scene zooms in on an agent's island. */
const ISLAND_ZOOM = 2.2;
/** Where the island is moved to across the frame (%): just left of Home's mascot, clear of the speech bubble. */
const ISLAND_TARGET_X = 33;

/**
 * How far to slide the island (in % of the frame) toward `target`, from `spot` where the zoom leaves it, without
 * uncovering either edge of the zoomed scene.
 */
function slide(spot: number, target: number): number {
  return Math.min(Math.max(target - spot, (1 - ISLAND_ZOOM) * (100 - spot)), (ISLAND_ZOOM - 1) * spot);
}

/**
 * The zoomed scene is an enlarged, positioned image rather than a CSS transform: scaling the 2880px scene with
 * `transform` makes a ~7500px composited layer, which Chrome can show blank until it has rasterized it. Laid out
 * this size, only the visible part is ever painted. object-position puts the island's point of the image at the
 * same point of this box, so the box is placed to land that point at the target.
 */
function islandFocus(island: AgentIsland): CSSProperties {
  const spot = ISLAND_SPOTS[island];
  const left = spot.x * (1 - ISLAND_ZOOM) + slide(spot.x, ISLAND_TARGET_X);
  const top = spot.y * (1 - ISLAND_ZOOM) + slide(spot.y, spot.top);
  return {
    position: "absolute",
    left: `${left}%`,
    top: `${top}%`,
    width: `${ISLAND_ZOOM * 100}%`,
    height: `${ISLAND_ZOOM * 100}%`,
    maxWidth: "none",
    objectPosition: `${spot.x}% ${spot.y}%`,
  };
}

/**
 * The pixel-art scene behind Home's title, in the app and on the public site. It fills its (positioned) parent
 * and fades out at the bottom. Until a scene's image exists, or if it fails to load, a dithered sky stands in.
 * With an `island`, the scene zooms in on that agent's island (an agent's Home).
 */
export function HeroArt({ className, island }: { className?: string; island?: AgentIsland }) {
  const theme = useResolvedTheme();
  const src = SCENES[theme];
  const [failed, setFailed] = useState<string | null>(null);
  const focus = island ? islandFocus(island) : undefined;

  return (
    <div aria-hidden="true" className={clsx("hero-art pointer-events-none absolute inset-0 overflow-hidden", className)}>
      {failed === src ? (
        <div className="hero-fallback size-full" />
      ) : (
        <img key={src} src={src} alt="" decoding="async" onError={() => setFailed(src)} style={focus} className="size-full object-cover" />
      )}
    </div>
  );
}
