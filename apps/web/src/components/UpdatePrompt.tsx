import { useState } from "react";
import { X } from "lucide-react";
import { useAppUpdate } from "../hooks/useAppUpdate";
import { totDesktop } from "../lib/desktop";
import { Button } from "./ui/Button";
import { IconButton } from "./ui/IconButton";
import { Tip } from "./ui/Tip";

/**
 * "Update ready" at the foot of the sidebar, in the Mac app only, once a new version is downloaded: one restart
 * installs it (quitting TOT does too). Dismissing hides it until TOT next starts.
 */
export function UpdatePrompt() {
  const version = useAppUpdate();
  const [restarting, setRestarting] = useState(false);
  if (!version) return null;
  const updates = totDesktop?.updates;

  return (
    <div role="status" className="mx-2 mb-2 shrink-0 animate-pop-in rounded-xl border border-hairline">
      <div className="flex items-center gap-2 py-1.5 pr-1.5 pl-3">
        <p className="min-w-0 flex-1 truncate text-ui">
          <span className="font-medium text-fg">Update ready</span>
          <span className="ml-1.5 text-fg-subtle tabular-nums">TOT {version}</span>
        </p>
        <Tip content="Dismiss">
          <IconButton label="Dismiss" size="sm" onClick={() => void updates?.dismiss()}>
            <X />
          </IconButton>
        </Tip>
      </div>
      <div className="px-3 pb-3">
        <Button
          size="sm"
          disabled={restarting}
          onClick={() => {
            setRestarting(true);
            void updates?.install();
          }}
        >
          {restarting ? "Restarting…" : "Restart to update"}
        </Button>
      </div>
    </div>
  );
}
