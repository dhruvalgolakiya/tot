/**
 * Quick open's matching: the query's letters in order anywhere in the path, ranked so that matches in the file's
 * own name, at the start of words and in runs come first, and shorter paths before longer ones.
 */

export interface FuzzyMatch {
  path: string;
  score: number;
  /** Indexes of the matched characters, for highlighting. */
  indexes: number[];
}

const BOUNDARY = /[/_\-. ]/;

function score(path: string, query: string): FuzzyMatch | null {
  const lower = path.toLowerCase();
  const nameStart = path.lastIndexOf("/") + 1;
  const indexes: number[] = [];
  let total = 0;
  let from = 0;
  let run = 0;
  for (const char of query) {
    const at = lower.indexOf(char, from);
    if (at < 0) return null;
    let points = 1;
    if (at === from && indexes.length) points += 4 + run++;
    else run = 0;
    if (at === 0 || BOUNDARY.test(path[at - 1]!) || (path[at] !== lower[at] && path[at - 1] === lower[at - 1])) points += 6;
    if (at >= nameStart) points += 3;
    indexes.push(at);
    total += points;
    from = at + 1;
  }
  // The whole name typed, or its start: what someone typing a file's name expects first.
  const name = lower.slice(nameStart);
  if (name.startsWith(query)) total += 20;
  if (name === query) total += 30;
  return { path, score: total - path.length / 50, indexes };
}

export function fuzzyFind(paths: string[], query: string, limit = 50): FuzzyMatch[] {
  const typed = query.toLowerCase().replace(/\s+/g, "");
  if (!typed) return paths.slice(0, limit).map((path) => ({ path, score: 0, indexes: [] }));
  const matches: FuzzyMatch[] = [];
  for (const path of paths) {
    const match = score(path, typed);
    if (match) matches.push(match);
  }
  return matches.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
}
