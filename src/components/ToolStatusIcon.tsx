import { Check, CircleDashed, LoaderCircle, X } from "lucide-react";
import type { ToolDisplayStatus } from "../lib/tools";

const LABELS: Record<ToolDisplayStatus, string> = {
  running: "Running",
  done: "Done",
  error: "Failed",
  interrupted: "Interrupted",
};

export function ToolStatusIcon({ status }: { status: ToolDisplayStatus }) {
  const label = LABELS[status];
  switch (status) {
    case "running":
      return <LoaderCircle aria-label={label} className="size-4 shrink-0 animate-spin text-accent" />;
    case "done":
      return <Check aria-label={label} className="size-4 shrink-0 text-success" />;
    case "error":
      return <X aria-label={label} className="size-4 shrink-0 text-danger" />;
    case "interrupted":
      return <CircleDashed aria-label={label} className="size-4 shrink-0 text-fg-subtle" />;
  }
}
