/**
 * The window's rules (roadmap module 08): where it opens (the size and place it had last time, as long as that
 * is still on a screen) and which links stay in it (TOT's own pages) or go to the default browser.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What the app remembers about the window between launches. */
export interface SavedWindow {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  maximized?: boolean;
}

export const DEFAULT_SIZE = { width: 1280, height: 840 };
/** Below 768 CSS px the web app switches to its phone layout, which doesn't leave room for the traffic lights. */
export const MIN_SIZE = { width: 800, height: 520 };
/** This much of the top edge must be on a screen, so the window can still be dragged back. */
const GRIP = { width: 120, height: 40 };

const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/**
 * Where the window opens. The saved place, if its top edge is still on one of `screens` (work areas, i.e.
 * without the menu bar and Dock), moved inside that screen if it hangs off it; otherwise the saved size,
 * centred on the primary screen. Sizes shrink to fit the screen.
 */
export function placeWindow(saved: SavedWindow | null, screens: Rect[], primary: Rect): Rect {
  const size = (area: Rect) => ({
    width: Math.round(clamp(isNumber(saved?.width) ? saved.width : DEFAULT_SIZE.width, Math.min(MIN_SIZE.width, area.width), area.width)),
    height: Math.round(clamp(isNumber(saved?.height) ? saved.height : DEFAULT_SIZE.height, Math.min(MIN_SIZE.height, area.height), area.height)),
  });
  if (saved && isNumber(saved.x) && isNumber(saved.y)) {
    const { x, y } = saved;
    const width = isNumber(saved.width) ? saved.width : DEFAULT_SIZE.width;
    const area = screens.find(
      (s) =>
        y >= s.y &&
        y + GRIP.height <= s.y + s.height &&
        Math.min(x + width, s.x + s.width) - Math.max(x, s.x) >= GRIP.width,
    );
    if (area) {
      const fitted = size(area);
      return {
        x: Math.round(clamp(x, area.x, area.x + area.width - fitted.width)),
        y: Math.round(clamp(y, area.y, area.y + area.height - fitted.height)),
        ...fitted,
      };
    }
  }
  const fitted = size(primary);
  return {
    x: Math.round(primary.x + (primary.width - fitted.width) / 2),
    y: Math.round(primary.y + (primary.height - fitted.height) / 2),
    ...fitted,
  };
}

/** TOT's own pages: the server on `port`, by a loopback name (the window loads http://localhost:<port>/). */
export function isAppUrl(url: string, port: number): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" && parsed.port === String(port) && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

/** Links the default browser (or mail app) may open. Anything else (file:, custom schemes) goes nowhere. */
export function isExternalUrl(url: string): boolean {
  try {
    return ["http:", "https:", "mailto:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}
