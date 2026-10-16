import { useId } from "react";

/** The TOT mark (two rings and a stroke) in the violet→cyan gradient. */
export function Logo({ className }: { className?: string }) {
  // useId() may contain characters that aren't safe inside url(#…).
  const gradient = `tot-logo-${useId().replace(/[^\w-]/g, "")}`;
  return (
    <svg viewBox="8 12 48 40" fill="none" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#a78bfa" />
          <stop offset="1" stopColor="#22d3ee" />
        </linearGradient>
      </defs>
      <circle cx="20" cy="32" r="9" stroke={`url(#${gradient})`} strokeWidth="5" />
      <circle cx="44" cy="32" r="9" stroke={`url(#${gradient})`} strokeWidth="5" />
      <path d="M32 14v36" stroke={`url(#${gradient})`} strokeWidth="5" strokeLinecap="round" />
    </svg>
  );
}
