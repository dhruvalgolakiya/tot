import { Check, Copy } from "lucide-react";
import { useCopy } from "../../hooks/useCopy";
import { Tip } from "../ui/Tip";

/**
 * A sign-in/verification code, shown prominently and copyable in one click.
 * Stops the click from bubbling so it works inside a clickable mail row too.
 */
export function CodeChip({ code }: { code: string }) {
  const { copied, copy } = useCopy();

  return (
    <Tip content={copied ? "Copied" : "Copy code"}>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          void copy(code);
        }}
        className="inline-flex items-center gap-1.5 rounded-md border border-edge bg-fill-subtle px-2 py-0.5 font-mono text-xs font-semibold tracking-wider text-fg transition-colors hover:border-edge-strong hover:bg-hover"
      >
        {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
        {code}
      </button>
    </Tip>
  );
}
