import { headingsOf, smarten, type Heading } from "./headings";
import { PAGES, type DocPage } from "./manifest";

// Every page's markdown, bundled as text: ./content/<slug>.md, and index.md for the docs home.
const FILES = import.meta.glob<string>("./content/*.md", { query: "?raw", import: "default", eager: true });

export function sourceFor(page: DocPage): string {
  return FILES[`./content/${page.slug || "index"}.md`] ?? "";
}

export interface SearchEntry {
  key: string;
  page: DocPage;
  /** Set for a heading inside a page; absent for the page itself. */
  heading?: Heading;
  label: string;
  hint: string;
  terms: string;
}

/** Titles, descriptions and headings: what ⌘K searches. */
export const SEARCH: SearchEntry[] = PAGES.flatMap((page) => {
  const headings = headingsOf(sourceFor(page));
  return [
    { key: page.slug || "home", page, label: smarten(page.title), hint: smarten(page.description), terms: `${page.nav ?? ""} ${page.description}` },
    ...headings.map((heading) => ({
      key: `${page.slug || "home"}#${heading.id}`,
      page,
      heading,
      label: heading.text,
      hint: smarten(page.title),
      terms: page.title,
    })),
  ];
});

/** Lowercase, with curly quotes straightened, so "what's" finds “What’s in TOT”. */
export const normalize = (text: string) => text.toLowerCase().replace(/[’‘]/g, "'").replace(/[“”]/g, '"');

/** 0 = no match; higher is better. Every word must appear; titles that start with the query rank first. */
export function score(entry: SearchEntry, words: string[]): number {
  const label = normalize(entry.label);
  const haystack = `${label} ${normalize(entry.terms)}`;
  if (!words.every((word) => haystack.includes(word))) return 0;
  const query = words.join(" ");
  const pageBonus = entry.heading ? 0 : 1;
  if (label.startsWith(query)) return 6 + pageBonus;
  if (label.split(/[\s’'/-]+/).some((part) => part.startsWith(words[0]!))) return 4 + pageBonus;
  return (label.includes(query) ? 2 : 1) + pageBonus;
}
