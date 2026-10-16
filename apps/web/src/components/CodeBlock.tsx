import type { ComponentProps } from "react";
import type { ExtraProps } from "react-markdown";
import type { Element, ElementContent } from "hast";
import { Check, Copy } from "lucide-react";
import { useCopy } from "../hooks/useCopy";
import { MermaidDiagram } from "./MermaidDiagram";

type CodeBlockProps = ComponentProps<"pre"> & ExtraProps;

/** Fenced code block: language label, copy button, highlighted code. Replaces <pre>. A ```mermaid block renders as a diagram instead. */
export function CodeBlock({ node, children, ...props }: CodeBlockProps) {
  const code = node?.children.find(
    (child): child is Element => child.type === "element" && child.tagName === "code",
  );
  const language = code ? languageOf(code) : "";
  const { copied, copy } = useCopy();

  const plainBlock = (
    <div className="code-block dark not-prose my-4 overflow-hidden rounded-xl border border-white/[0.08] bg-[#0e0e13]">
      <div className="flex items-center justify-between border-b border-white/[0.06] bg-white/[0.02] py-1 pr-1.5 pl-3.5">
        <span className="font-mono text-xs text-zinc-500">{language || "text"}</span>
        <button
          type="button"
          onClick={() => void copy(code ? textOf(code).replace(/\n$/, "") : "")}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100"
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre {...props}>{children}</pre>
    </div>
  );

  if (language === "mermaid" && code) {
    return <MermaidDiagram code={textOf(code).replace(/\n$/, "")} fallback={plainBlock} />;
  }
  return plainBlock;
}

function languageOf(code: Element): string {
  const match = code.properties.className?.find((name) => String(name).startsWith("language-"));
  return match ? match.slice("language-".length) : "";
}

function textOf(node: ElementContent): string {
  if (node.type === "text") return node.value;
  if (node.type === "element") return node.children.map(textOf).join("");
  return "";
}
