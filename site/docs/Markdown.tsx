import { useMemo, useState, type ComponentProps, type ReactNode } from "react";
import ReactMarkdown, { type Components, type ExtraProps } from "react-markdown";
import remarkGfm from "remark-gfm";
import clsx from "clsx";
import type { Element, ElementContent } from "hast";
import { Check, Copy, Info, Link2 } from "lucide-react";
import { headingsOf, smarten, type Heading } from "./headings";
import { STATUS_LABEL, type Status } from "./manifest";
import { isDocsLink, onDocsLinkClick } from "./router";
import { StatusChip } from "./StatusChip";

const STATUS_PREFIX = /^\[(available|partly|not yet)\]\s*/i;

type MdNode = { type: string; value?: string; children?: MdNode[]; data?: { hProperties?: Record<string, unknown> } };

/**
 * A list item that starts with [Available], [Partly] or [Not yet] becomes a status row: the prefix is taken out
 * and the item gets a data-status the renderer turns into a chip.
 */
function remarkStatus() {
  const walk = (node: MdNode) => {
    if (node.type === "listItem") {
      const text = node.children?.[0]?.type === "paragraph" ? node.children[0].children?.[0] : undefined;
      const match = text?.type === "text" && text.value ? STATUS_PREFIX.exec(text.value) : null;
      if (text && match) {
        text.value = text.value!.slice(match[0].length);
        const status = match[1]!.toLowerCase().replace(" ", "-") as Status;
        node.data = { ...node.data, hProperties: { ...node.data?.hProperties, "data-status": status } };
      }
    }
    node.children?.forEach(walk);
  };
  return (tree: MdNode) => walk(tree);
}

const INLINE = new Set(["emphasis", "strong", "delete", "link", "linkReference"]);

/** Curly quotes in prose (not in code), carrying the previous character across links and emphasis. */
function remarkSmartQuotes() {
  const walk = (node: MdNode, before: string): string => {
    let last = before;
    for (const child of node.children ?? []) {
      if (child.type === "text" && child.value) {
        child.value = smarten(child.value, last);
        last = child.value.at(-1) ?? last;
      } else if (child.type === "inlineCode" && child.value) last = child.value.at(-1) ?? last;
      else if (child.type !== "code" && child.type !== "html" && child.children) last = walk(child, INLINE.has(child.type) ? last : "");
    }
    return last;
  };
  return (tree: MdNode) => void walk(tree, "");
}

const remarkPlugins = [remarkGfm, remarkStatus, remarkSmartQuotes];

function textOf(node: ElementContent): string {
  if (node.type === "text") return node.value;
  if (node.type === "element") return node.children.map(textOf).join("");
  return "";
}

/** A fenced code block, with a copy button that shows on hover (always, on touch screens). */
function CodeBlock({ node, children, ...props }: ComponentProps<"pre"> & ExtraProps) {
  const [copied, setCopied] = useState(false);
  const code = node?.children.find((child): child is Element => child.type === "element" && child.tagName === "code");
  async function copy() {
    try {
      await navigator.clipboard.writeText(code ? textOf(code).replace(/\n$/, "") : "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // No clipboard access: the text is still selectable.
    }
  }
  return (
    <div className="group relative my-6 rounded-xl border border-hairline bg-panel">
      <pre {...props} className="overflow-x-auto px-4 py-3.5 pr-20 font-mono text-[13px] leading-6 text-fg">
        {children}
      </pre>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label={copied ? "Copied" : "Copy code"}
        className="absolute top-2 right-2 inline-flex h-7 items-center gap-1.5 rounded-full border border-edge bg-elevated px-2.5 text-xs font-medium text-fg-muted opacity-0 transition-[opacity,color] group-hover:opacity-100 hover:text-fg focus-visible:opacity-100 pointer-coarse:opacity-100"
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/** Inline code that's a keyboard shortcut (⌘K, ⌘⇧M, ⌘↩) reads as a key, not as code. */
const SHORTCUT = /^[⌘⇧⌥⌃]+\S+$/;

function Anchor({ id, depth, children }: { id: string; depth: 2 | 3; children: ReactNode }) {
  const Tag = depth === 2 ? "h2" : "h3";
  return (
    <Tag
      id={id}
      className={clsx(
        "group/heading scroll-mt-24 text-fg-strong",
        depth === 2 ? "mt-14 mb-4 font-display text-2xl font-semibold tracking-tight" : "mt-9 mb-3 text-[17px] leading-7 font-semibold tracking-tight",
      )}
    >
      {children}
      <a
        href={`#${id}`}
        onClick={(event) => onDocsLinkClick(event, `#${id}`)}
        aria-label="Link to this section"
        className="ml-2 inline-flex translate-y-[-1px] align-middle text-fg-faint opacity-0 transition-opacity group-hover/heading:opacity-100 hover:text-fg-muted focus-visible:opacity-100"
      >
        <Link2 className="size-4" />
      </a>
    </Tag>
  );
}

function components(headings: Heading[]): Components {
  const idAt = (line: number | undefined) => headings.find((heading) => heading.line === line)?.id;
  return {
    h2: ({ node, children }) => (
      <Anchor id={idAt(node?.position?.start.line) ?? ""} depth={2}>
        {children}
      </Anchor>
    ),
    h3: ({ node, children }) => (
      <Anchor id={idAt(node?.position?.start.line) ?? ""} depth={3}>
        {children}
      </Anchor>
    ),
    p: ({ node: _node, ...props }) => <p className="my-4" {...props} />,
    a: ({ node: _node, href, children, ...props }) => {
      const link = "font-medium text-fg underline decoration-edge-strong decoration-1 underline-offset-4 transition-colors hover:decoration-fg";
      if (isDocsLink(href)) {
        return (
          <a href={href} onClick={(event) => onDocsLinkClick(event, href)} className={link} {...props}>
            {children}
          </a>
        );
      }
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" className={link} {...props}>
          {children}
        </a>
      );
    },
    strong: ({ node: _node, ...props }) => <strong className="font-semibold text-fg-strong" {...props} />,
    ul: ({ node: _node, ...props }) => <ul className="docs-ul my-4 space-y-2 pl-5" {...props} />,
    ol: ({ node: _node, ...props }) => <ol className="docs-ol my-5 space-y-3" {...props} />,
    li: ({ node: _node, children, ...props }) => {
      const status = (props as { "data-status"?: Status })["data-status"];
      if (!status) return <li {...props}>{children}</li>;
      return (
        <li {...props} className="flex items-start justify-between gap-4 border-t border-hairline py-3 first:border-t-0">
          <div className="min-w-0 flex-1">{children}</div>
          <StatusChip status={status} className="mt-0.5" label={STATUS_LABEL[status]} />
        </li>
      );
    },
    blockquote: ({ node: _node, children }) => (
      <div className="my-6 flex gap-3 rounded-xl border border-hairline bg-fill-subtle px-4 py-3.5 text-[15px] leading-relaxed text-fg-muted [&_p]:my-0 [&_p+p]:mt-2">
        <Info className="mt-1 size-4 shrink-0 text-fg-subtle" />
        <div className="min-w-0">{children}</div>
      </div>
    ),
    pre: CodeBlock,
    code: ({ node: _node, className, children, ...props }) => {
      const text = String(children ?? "");
      if (className || text.includes("\n")) {
        return (
          <code className={className} {...props}>
            {children}
          </code>
        );
      }
      if (SHORTCUT.test(text)) {
        return (
          <kbd className="mx-0.5 inline-flex h-6 min-w-6 translate-y-[-1px] items-center justify-center rounded-md border border-edge bg-fill-subtle px-1.5 font-sans text-xs font-medium text-fg-muted tabular-nums">
            {text.replace(/↩/g, "↩\uFE0E")}
          </kbd>
        );
      }
      return (
        <code className="rounded-md bg-fill px-1.5 py-0.5 font-mono text-[0.85em] font-medium text-fg" {...props}>
          {children}
        </code>
      );
    },
    hr: () => <hr className="my-10 border-hairline" />,
    table: ({ node: _node, ...props }) => (
      <div className="my-6 overflow-x-auto">
        <table className="w-full border-collapse text-left text-sm" {...props} />
      </div>
    ),
    th: ({ node: _node, ...props }) => <th className="border-b border-edge py-2 pr-4 align-bottom text-xs font-medium text-fg-subtle" {...props} />,
    td: ({ node: _node, ...props }) => <td className="border-b border-hairline py-2.5 pr-4 align-top text-fg" {...props} />,
  };
}

/** A docs page's markdown: GitHub-flavored, with heading anchors, status rows, copyable code and key hints. */
export function Markdown({ source }: { source: string }) {
  const headings = useMemo(() => headingsOf(source), [source]);
  const rendered = useMemo(() => components(headings), [headings]);
  return (
    <div className="docs-prose text-base leading-7 text-fg">
      <ReactMarkdown remarkPlugins={remarkPlugins} components={rendered}>
        {source}
      </ReactMarkdown>
    </div>
  );
}
