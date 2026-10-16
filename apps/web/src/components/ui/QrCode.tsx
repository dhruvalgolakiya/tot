import { useMemo } from "react";
import { encode } from "uqr";

/**
 * A QR code, always black on white (in dark mode too): phone cameras read inverted codes badly. One path,
 * crisp edges, scaled to `size` pixels.
 */
export function QrCode({ value, size = 192, label }: { value: string; size?: number; label: string }) {
  const { path, modules } = useMemo(() => {
    const { data } = encode(value, { ecc: "M", border: 2 });
    let d = "";
    data.forEach((row, y) => row.forEach((on, x) => on && (d += `M${x} ${y}h1v1h-1z`)));
    return { path: d, modules: data.length };
  }, [value]);

  return (
    <svg
      role="img"
      aria-label={label}
      viewBox={`0 0 ${modules} ${modules}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      className="shrink-0 rounded-xl bg-fixed-white"
    >
      <path d={path} fill="#000" />
    </svg>
  );
}
