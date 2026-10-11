import Svg, { Circle, Defs, LinearGradient, Stop } from "react-native-svg";

/**
 * TOT's mark: the two rings of public/tot.svg and the app icon (mobile/scripts/icons.mts), violet to cyan. Its
 * gradient reads on both the light and the dark canvas.
 */
export function TotLogo({ size = 56 }: { size?: number }) {
  // As the icon script: each ring's stroke is about a fifth of its width, a sliver of space between them.
  const outer = 46;
  const stroke = outer * 0.217;
  const r = (outer - stroke) / 2;
  const offset = (outer + 2.5) / 2;
  return (
    <Svg width={size * 2} height={size} viewBox="0 0 100 50" accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Defs>
        <LinearGradient id="tot-ring" x1="0" y1="0" x2="1" y2="1">
          <Stop offset="0" stopColor="#a78bfa" />
          <Stop offset="1" stopColor="#22d3ee" />
        </LinearGradient>
      </Defs>
      <Circle cx={50 - offset} cy={25} r={r} fill="none" stroke="url(#tot-ring)" strokeWidth={stroke} />
      <Circle cx={50 + offset} cy={25} r={r} fill="none" stroke="url(#tot-ring)" strokeWidth={stroke} />
    </Svg>
  );
}
