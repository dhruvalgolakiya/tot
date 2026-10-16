import { useEffect, useState } from "react";
import { useReducedMotion } from "../ui";

/** Seconds since the page opened, for elapsed times, progress lines and meters that move. Holds still for reduced motion. */
export function useTicker(): number {
  const reduced = useReducedMotion();
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (reduced) return;
    const timer = setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [reduced]);
  return seconds;
}

/** "2m 05s". */
export const elapsed = (seconds: number) => `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
