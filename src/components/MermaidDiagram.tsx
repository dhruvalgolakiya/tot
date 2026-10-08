import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import clsx from "clsx";
import { useResolvedTheme } from "../lib/theme";

type Status = "loading" | "ok" | "error";

/**
 * Renders a ```mermaid fenced block as a diagram. The `mermaid` package is
 * fairly large, so it's only imported once a mermaid block actually shows up;
 * until it's ready (or if the diagram fails to parse) `fallback` — the normal
 * code block — is shown instead.
 */
export function MermaidDiagram({ code, fallback }: { code: string; fallback: ReactNode }) {
  const rawId = useId().replace(/[^\w-]/g, "");
  const theme = useResolvedTheme();
  const [svg, setSvg] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  // Guards against a slow import/render resolving after a newer one started
  // (the code or theme changed again while it was in flight).
  const generation = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const gen = ++generation.current;
    setStatus("loading");

    import("mermaid")
      .then(async ({ default: mermaid }) => {
        if (cancelled || gen !== generation.current) return;
        // suppressErrorRendering: on a bad diagram mermaid would otherwise draw its own "Syntax error" bomb
        // straight onto the page, outside this component. Parse first, so a bad one just stays a code block.
        mermaid.initialize({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true, theme: theme === "dark" ? "dark" : "default" });
        if (!(await mermaid.parse(code, { suppressErrors: true }))) throw new Error("Not a valid diagram");
        if (cancelled || gen !== generation.current) return;
        const id = `mermaid-${rawId}-${gen}`;
        const { svg: rendered } = await mermaid.render(id, code).finally(() => document.getElementById(`d${id}`)?.remove());
        if (cancelled || gen !== generation.current) return;
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
