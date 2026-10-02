import { Check, CircleDashed, LoaderCircle, X } from "lucide-react";
import type { ToolDisplayStatus } from "../lib/tools";

const LABELS: Record<ToolDisplayStatus, string> = {
  running: "Running",
  done: "Done",
  error: "Failed",
  interrupted: "Interrupted",
};

/** Small, subtle marker next to a tool row — only an error carries color. */
export function ToolStatusIcon({ status }: { status: ToolDisplayStatus }) {
  const label = LABELS[status];
  switch (status) {
    case "running":
      return <LoaderCircle aria-label={label} className="size-4 shrink-0 animate-spin text-fg-subtle" />;
    case "done":
      return <Check aria-label={label} className="size-4 shrink-0 text-fg-subtle" />;
    case "error":
      return <X aria-label={label} className="size-4 shrink-0 text-danger" />;
    case "interrupted":
      return <CircleDashed aria-label={label} className="size-4 shrink-0 text-fg-subtle" />;
  }
}
