import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import { useResolvedTheme } from "../lib/theme";

type Status = "loading" | "ok" | "error";

/**
 * Finished diagrams by theme and code, most recently used last, so a chat opened again shows its diagrams
 * straight away instead of its code blocks first. Each copy gets its own ids (the SVG's styles and arrowheads
 * refer to them, and two copies can be in the page at once).
 */
const diagrams = new Map<string, { svg: string; id: string }>();
const MAX_DIAGRAMS = 40;

function cachedDiagram(key: string, id: string): string | null {
  const hit = diagrams.get(key);
  if (!hit) return null;
  diagrams.delete(key);
  diagrams.set(key, hit);
  return hit.id === id ? hit.svg : hit.svg.replaceAll(hit.id, id);
}

function rememberDiagram(key: string, svg: string, id: string) {
  diagrams.delete(key);
  diagrams.set(key, { svg, id });
  for (const [oldest] of diagrams) {
    if (diagrams.size <= MAX_DIAGRAMS) break;
    diagrams.delete(oldest);
  }
}

/**
 * Renders a ```mermaid fenced block as a diagram. The `mermaid` package is
 * fairly large, so it's only imported once a mermaid block actually shows up;
 * until it's ready (or if the diagram fails to parse) `fallback` — the normal
 * code block — is shown instead.
 */
export function MermaidDiagram({ code, fallback }: { code: string; fallback: ReactNode }) {
  const rawId = useId().replace(/[^\w-]/g, "");
  const theme = useResolvedTheme();
  const [svg, setSvg] = useState(() => cachedDiagram(`${theme}\n${code}`, `mermaid-${rawId}-0`));
  const [status, setStatus] = useState<Status>(() => (svg ? "ok" : "loading"));
  // Guards against a slow import/render resolving after a newer one started
  // (the code or theme changed again while it was in flight).
  const generation = useRef(0);
  // The theme and code of the diagram on screen: a chat shown again after being hidden keeps it, no re-render.
  const shown = useRef<string | null>(svg ? `${theme}\n${code}` : null);

  useEffect(() => {
    const key = `${theme}\n${code}`;
    if (shown.current === key) return;
    let cancelled = false;
    const gen = ++generation.current;
    const id = `mermaid-${rawId}-${gen}`;
    const cached = cachedDiagram(key, id);
    if (cached) {
      shown.current = key;
      setSvg(cached);
      setStatus("ok");
      return;
    }
    setStatus("loading");

    import("mermaid")
      .then(async ({ default: mermaid }) => {
        if (cancelled || gen !== generation.current) return;
        // suppressErrorRendering: on a bad diagram mermaid would otherwise draw its own "Syntax error" bomb
        // straight onto the page, outside this component. Parse first, so a bad one just stays a code block.
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true, theme: theme === "dark" ? "dark" : "default" });
        if (!(await mermaid.parse(code, { suppressErrors: true }))) throw new Error("Not a valid diagram");
        if (cancelled || gen !== generation.current) return;
        const { svg: rendered } = await mermaid.render(id, code).finally(() => document.getElementById(`d${id}`)?.remove());
        if (cancelled || gen !== generation.current) return;
        rememberDiagram(key, rendered, id);
        shown.current = key;
        setSvg(rendered);
        setStatus("ok");
      })
      .catch(() => {
        if (!cancelled && gen === generation.current) setStatus("error");
      });

    return () => {
      cancelled = true;
    };
  }, [code, theme, rawId]);

  if (status !== "ok" || !svg) return <>{fallback}</>;
  return (
    <div
      className={clsx(
        "not-prose my-4 overflow-x-auto rounded-xl border p-4 [&_svg]:mx-auto",
        theme === "dark" ? "border-white/[0.08] bg-[#0e0e13]" : "border-black/[0.08] bg-white",
      )}
      // mermaid's own SVG output; securityLevel "strict" sanitizes it.
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
