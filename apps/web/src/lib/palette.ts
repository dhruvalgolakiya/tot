import { create } from "zustand";

/** The command palette (⌘K): open or not. Its own small store, so opening it doesn't touch the app's. */
export const usePalette = create<{ open: boolean }>()(() => ({ open: false }));

export const setPaletteOpen = (open: boolean) => usePalette.setState({ open });
export const togglePalette = () => setPaletteOpen(!usePalette.getState().open);

/** Words of a query, lowercased, for matching titles and names: every one must be found. */
export function queryWords(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))];
}

/**
 * How well `text` matches every word: 3 when it starts with the first word, 2 when a word of it does, 1 when the words
 * are only inside words, 0 when one is missing.
 */
export function matchScore(text: string, words: string[]): number {
  if (!words.length) return 1;
  const lower = text.toLowerCase();
  if (!words.every((word) => lower.includes(word))) return 0;
  if (lower.startsWith(words[0]!)) return 3;
  return words.some((word) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(word)}`, "u").test(lower)) ? 2 : 1;
}

/** `text` cut into the pieces that match one of `words` and the ones between, for highlighting. */
export function highlightParts(text: string, words: string[]): { text: string; match?: true }[] {
  if (!words.length) return [{ text }];
  const pattern = new RegExp(`(${words.map(escapeRegExp).join("|")})`, "giu");
  return text
    .split(pattern)
    .filter(Boolean)
    .map((piece) => (words.includes(piece.toLowerCase()) ? { text: piece, match: true as const } : { text: piece }));
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
