import { memo, useMemo, type ReactElement } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import rehypeHighlight from "rehype-highlight";
import clsx from "clsx";
import "katex/dist/katex.min.css";
import "highlight.js/styles/github-dark.css";
import { prepareMarkdown } from "../lib/markdown";
import { CodeBlock } from "./CodeBlock";

// Math only runs where there can be some: a $ (prepareMarkdown has turned \( \) and \[ \] into $), or a ```math
// block. Without either, remark-math and rehype-katex leave the tree as it is, so skipping them changes nothing.
const plugins = { remarkPlugins: [remarkGfm], rehypePlugins: [rehypeHighlight] };
const mathPlugins = { remarkPlugins: [remarkGfm, remarkMath], rehypePlugins: [rehypeKatex, rehypeHighlight] };
const MATH = /\$|^ {0,3}(?:`{3,}|~{3,})\s*math\b/m;

const components: Components = {
  a: ({ node: _node, href, ...props }) =>
    /^https?:\/\//i.test(href ?? "") ? (
      <a href={href} target="_blank" rel="noopener noreferrer" {...props} />
    ) : (
      <a href={href} {...props} />
    ),
  pre: CodeBlock,
  table: ({ node: _node, ...props }) => (
    <div className="table-wrap">
      <table {...props} />
    </div>
  ),
};

/**
 * Rendered markdown by its text, least recently used first: reopening a chat (or a remounted message) reuses
 * the elements instead of parsing again. Bounded by the total text it holds, since each entry keeps its tree.
 */
const rendered = new Map<string, ReactElement>();
let renderedChars = 0;
const MAX_CACHED_CHARS = 1_000_000;

function render(text: string, cache: boolean): ReactElement {
  const hit = rendered.get(text);
  if (hit) {
    rendered.delete(text);
    rendered.set(text, hit);
    return hit;
  }
  const source = prepareMarkdown(text);
  const element = ReactMarkdown({ children: source, components, ...(MATH.test(source) ? mathPlugins : plugins) });
  if (cache && text.length <= MAX_CACHED_CHARS / 4) {
    rendered.set(text, element);
    renderedChars += text.length;
    for (const [oldest] of rendered) {
      if (renderedChars <= MAX_CACHED_CHARS) break;
      rendered.delete(oldest);
      renderedChars -= oldest.length;
    }
  }
  return element;
}

type MarkdownProps = {
  text: string;
  /** Show a blinking caret after the last block (streaming). */
  caret?: boolean;
  /** Smaller, dimmer variant (reasoning). */
  muted?: boolean;
  /** The text is still growing (streaming): don't keep each version of it. */
  live?: boolean;
};

/** GFM + KaTeX + highlighted code, styled with prose-invert. */
export const Markdown = memo(function Markdown({ text, caret = false, muted = false, live = false }: MarkdownProps) {
  const content = useMemo(() => render(text, !caret && !live), [text, caret, live]);
  return (
    <div
      className={clsx(
        "markdown prose prose-invert max-w-none",
        muted ? "markdown-muted prose-sm" : "prose-base",
        caret && "streaming-caret",
      )}
    >
      {content}
    </div>
  );
});
