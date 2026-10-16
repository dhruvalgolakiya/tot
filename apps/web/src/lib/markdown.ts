// Models emit LaTeX as \( … \) / \[ … \] and prices as "$5"; remark-math only
// understands $ delimiters. Normalize prose (never code) before rendering.

const CODE = /(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g;

export function prepareMarkdown(source: string): string {
  return source
    .split(CODE)
    .map((segment, index) => (index % 2 === 1 ? segment : normalizeProse(segment)))
    .join("");
}

function normalizeProse(text: string): string {
  return (
    text
      // "$5 and $10" is money, not math: escape a lone $ that precedes a digit.
      .replace(/(^|[^\\$])\$(?=\d)/g, (_, before: string) => `${before}\\$`)
      .replace(/\\\[([\s\S]+?)\\\]/g, (_, math: string) => `\n$$\n${math.trim()}\n$$\n`)
      .replace(/\\\((.+?)\\\)/g, (_, math: string) => `$${math}$`)
  );
}
