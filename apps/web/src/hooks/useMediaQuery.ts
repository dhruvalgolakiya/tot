import { useCallback, useSyncExternalStore } from "react";

export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    [query],
  );
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches);
}

export const DESKTOP_QUERY = "(min-width: 768px)";
export const WIDE_QUERY = "(min-width: 1024px)";
export const XL_QUERY = "(min-width: 1280px)";
