import { memo, useMemo } from "react";
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

const remarkPlugins = [remarkGfm, remarkMath];
const rehypePlugins = [rehypeKatex, rehypeHighlight];

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

type MarkdownProps = {
  text: string;
  /** Show a blinking caret after the last block (streaming). */
  caret?: boolean;
  /** Smaller, dimmer variant (reasoning). */
  muted?: boolean;
};

/** GFM + KaTeX + highlighted code, styled with prose-invert. */
export const Markdown = memo(function Markdown({ text, caret = false, muted = false }: MarkdownProps) {
  const source = useMemo(() => prepareMarkdown(text), [text]);
  return (
    <div
      className={clsx(
        "markdown prose prose-invert max-w-none",
        muted ? "markdown-muted prose-sm" : "prose-base",
        caret && "streaming-caret",
      )}
    >
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components}>
        {source}
      </ReactMarkdown>
    </div>
  );
});
