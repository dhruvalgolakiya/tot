/** Headings in a page's markdown: for the on-this-page list, anchors and search. */
export interface Heading {
  depth: 2 | 3;
  text: string;
  id: string;
  /** 1-based source line, to match the rendered heading to its id. */
  line: number;
}

/** "Merge into main (folders)" → "merge-into-main-folders". */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[’‘']/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Typographer's quotes: "x" → “x”, it's → it’s. The markdown keeps plain quotes, so it stays easy to edit.
 * `before` is the character that precedes `text` (from the previous text node), so a quote after a link closes.
 */
export function smarten(text: string, before = ""): string {
  let out = "";
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    const previous = index ? text[index - 1]! : before;
    const opens = !previous || /[\s([{“‘—–-]/.test(previous);
    if (char === '"') out += opens ? "“" : "”";
    else if (char === "'") out += opens ? "‘" : "’";
    else out += char;
  }
  return out;
}

/** Markdown inline syntax down to plain text: links, code, emphasis. */
export function plain(text: string): string {
  return smarten(
    text
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/`([^`]*)`/g, "$1")
      .replace(/(\*\*|__|\*|_)(.+?)\1/g, "$2")
      .trim(),
  );
}

export function headingsOf(markdown: string): Heading[] {
  const seen = new Map<string, number>();
  const headings: Heading[] = [];
  let fenced = false;
  markdown.split("\n").forEach((source, index) => {
    if (/^\s*(```|~~~)/.test(source)) fenced = !fenced;
    if (fenced) return;
    const match = /^(#{2,3})\s+(.+?)\s*#*\s*$/.exec(source);
    if (!match) return;
    const text = plain(match[2]!);
    const base = slugify(text) || "section";
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    headings.push({ depth: match[1]!.length as 2 | 3, text, id: count ? `${base}-${count + 1}` : base, line: index + 1 });
  });
  return headings;
}
