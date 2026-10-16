import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { copyText } from "../lib/clipboard";

/** Copy to the clipboard and flip `copied` on for a moment. */
export function useCopy(resetAfterMs = 1500) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = useCallback(
    async (text: string) => {
      if (!(await copyText(text))) {
        toast.error("Couldn't copy to the clipboard.");
        return;
      }
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), resetAfterMs);
    },
    [resetAfterMs],
  );

  return { copied, copy };
}
