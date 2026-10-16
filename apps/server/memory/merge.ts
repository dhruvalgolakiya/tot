/**
 * Merging memory markdown (roadmap module 10). Two copies of a file that both changed since their merge base
 * merge entry by entry, by id, so a delete on one side survives the other side's additions (a line-based or union
 * merge can't express a delete):
 *  - removed on one side and unchanged on the other: removed;
 *  - edited on one side: that edit wins, also over a delete on the other;
 *  - edited differently on both: both kept (Dreaming tidies them later);
 *  - added on either side: kept, in a stable order.
 * Everything else in the file (headings, prose, links) merges three-way by line, and where both sides changed the
 * same lines, this device's version wins. Pure functions: repo.ts reads the three versions and commits the result.
 */

/** An entry's place in a file: its line and its id (its own, or derived from its text). */
export interface EntryLine {
  line: number;
  id: string;
}

/** Past this many line pairs a diff isn't worth it: the file is kept as this device has it. */
const MAX_CELLS = 4_000_000;

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((line, index) => line === b[index]);

/** For each line of `a`, the line of `b` it matches in a longest common subsequence, or -1. */
function matchLines(a: string[], b: string[]): Int32Array | null {
  const match = new Int32Array(a.length).fill(-1);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    match[start] = start;
    start++;
  }
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
    match[endA] = endB;
  }
  const n = endA - start;
  const m = endB - start;
  if (!n || !m) return match;
  if (n * m > MAX_CELLS) return null;
  const width = m + 1;
  const lengths = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lengths[i * width + j] = a[start + i] === b[start + j] ? lengths[(i + 1) * width + j + 1]! + 1 : Math.max(lengths[(i + 1) * width + j]!, lengths[i * width + j + 1]!);
    }
  }
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (a[start + i] === b[start + j]) {
      match[start + i] = start + j;
      i++;
      j++;
    } else if (lengths[(i + 1) * width + j]! >= lengths[i * width + j + 1]!) {
      i++;
    } else {
      j++;
    }
  }
  return match;
}

/**
 * A three-way merge of lines (diff3): where only one side changed a stretch of the base, its version is taken;
 * where both changed it differently, `conflict` decides. Null when the files are too big to compare.
 */
export function mergeLines(base: string[], ours: string[], theirs: string[], conflict: (base: string[], ours: string[], theirs: string[]) => string[]): string[] | null {
  const toOurs = matchLines(base, ours);
  const toTheirs = matchLines(base, theirs);
  if (!toOurs || !toTheirs) return null;
  const out: string[] = [];
  let i = 0;
  let o = 0;
  let t = 0;
  for (;;) {
    // The next base line both sides kept: everything before it is a stretch one or both changed.
    let k = i;
    while (k < base.length && (toOurs[k]! < 0 || toTheirs[k]! < 0)) k++;
    const oEnd = k < base.length ? toOurs[k]! : ours.length;
    const tEnd = k < base.length ? toTheirs[k]! : theirs.length;
    const b = base.slice(i, k);
    const mine = ours.slice(o, oEnd);
    const other = theirs.slice(t, tEnd);
    if (same(mine, other)) out.push(...mine);
    else if (same(mine, b)) out.push(...other);
    else if (same(other, b)) out.push(...mine);
    else out.push(...conflict(b, mine, other));
    if (k >= base.length) return out;
    out.push(base[k]!);
    i = k + 1;
    o = oEnd + 1;
    t = tEnd + 1;
  }
}

/** Entry lines stand in the skeleton as a mark: "\0<id>#<n>" for the n-th line with that id. */
const MARK = "\0";
const mark = (id: string, n: number) => `${MARK}${id}#${n}`;
const markId = (line: string) => line.slice(1, line.lastIndexOf("#"));
const markIndex = (line: string) => Number(line.slice(line.lastIndexOf("#") + 1));

interface Side {
  /** The file's lines, each entry line replaced by its mark. */
  skeleton: string[];
  /** Each id's lines, in file order. */
  byId: Map<string, string[]>;
}

function side(content: string, entriesOf: (content: string) => EntryLine[]): Side {
  const lines = content.split("\n");
  const skeleton = [...lines];
  const byId = new Map<string, string[]>();
  for (const { line, id } of entriesOf(content)) {
    const list = byId.get(id) ?? [];
    skeleton[line] = mark(id, list.length);
    list.push(lines[line]!);
    byId.set(id, list);
  }
  return { skeleton, byId };
}

/** Merges three versions of a markdown file entry by entry (see the top of this file). `base` is "" when there's none. */
export function mergeEntries(base: string, ours: string, theirs: string, entriesOf: (content: string) => EntryLine[]): string {
  const [b, o, t] = [base, ours, theirs].map((content) => side(content, entriesOf)) as [Side, Side, Side];
  const resolved = new Map<string, string[]>();
  const resolve = (id: string): string[] => {
    const known = resolved.get(id);
    if (known) return known;
    const was = b.byId.get(id) ?? [];
    const mine = o.byId.get(id) ?? [];
    const other = t.byId.get(id) ?? [];
    let lines: string[];
    if (same(mine, other) || same(other, was)) lines = mine;
    else if (same(mine, was)) lines = other;
    // Both changed it: an edit beats a delete, and two different edits are both kept.
    else if (!mine.length) lines = other;
    else if (!other.length) lines = mine;
    else lines = [...new Set([...mine, ...other])];
    resolved.set(id, lines);
    return lines;
  };

  // Where both sides changed the same stretch: this device's lines, plus the entries only the other side has there.
  const skeleton =
    mergeLines(b.skeleton, o.skeleton, t.skeleton, (_, mine, other) => [...mine, ...other.filter((line) => line.startsWith(MARK) && !mine.includes(line))]) ??
    [...o.skeleton, ...t.skeleton.filter((line) => line.startsWith(MARK) && !o.skeleton.includes(line))];

  const marks = new Set(skeleton.filter((line) => line.startsWith(MARK)));
  const placed = new Set([...marks].map(markId));
  const out: string[] = [];
  /** Which id each output line holds (null for other lines), to place entries that lost their spot. */
  const owners: (string | null)[] = [];
  const emitted = new Set<string>();
  const collapsed = new Set<string>();
  for (const line of skeleton) {
    if (!line.startsWith(MARK)) {
      out.push(line);
      owners.push(null);
      continue;
    }
    if (emitted.has(line)) continue;
    emitted.add(line);
    const id = markId(line);
    const lines = resolve(id);
    // Each line in its own place when every one has a place; else all of them together, at the first.
    if (lines.every((_, index) => marks.has(mark(id, index)))) {
      const index = markIndex(line);
      if (index < lines.length) {
        out.push(lines[index]!);
        owners.push(id);
      }
    } else if (!collapsed.has(id)) {
      collapsed.add(id);
      out.push(...lines);
      owners.push(...lines.map(() => id));
    }
  }

  // Entries kept whose mark the line merge dropped (edited here, deleted there): next to their old neighbours.
  const order = [...new Set([...o.byId.keys(), ...t.byId.keys()])];
  for (const id of order) {
    const lines = resolve(id);
    if (!lines.length || placed.has(id)) continue;
    const from = o.byId.has(id) ? o : t;
    const neighbours = from.skeleton.filter((line) => line.startsWith(MARK)).map(markId);
    const at = neighbours.indexOf(id);
    let position = -1;
    for (let j = at - 1; j >= 0 && position < 0; j--) {
      const found = owners.lastIndexOf(neighbours[j]!);
      if (found >= 0) position = found + 1;
    }
    for (let j = at + 1; j < neighbours.length && position < 0; j++) {
      const found = owners.indexOf(neighbours[j]!);
      if (found >= 0) position = found;
    }
    if (position < 0) {
      // No neighbour left: after the file's last line with text, past a blank line.
      let end = out.length;
      while (end > 0 && !out[end - 1]!.trim()) end--;
      const lead = end > 0 && owners[end - 1] === null ? [""] : [];
      out.splice(end, 0, ...lead, ...lines);
      owners.splice(end, 0, ...lead.map(() => null), ...lines.map(() => id));
    } else {
      out.splice(position, 0, ...lines);
      owners.splice(position, 0, ...lines.map(() => id));
    }
    placed.add(id);
  }
  return out.join("\n");
}
