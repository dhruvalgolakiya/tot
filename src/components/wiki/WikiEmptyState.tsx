import type { MascotSpec } from "@shared/types";
import { MascotStage } from "../mascot";
import { Button } from "../ui/Button";

type WikiEmptyStateProps = {
  agentName: string;
  mascot: MascotSpec;
  onLearnRepo: () => void;
};

/** Shown when only the (still-empty) Overview page exists: nudge toward teaching the agent a codebase. */
export function WikiEmptyState({ agentName, mascot, onLearnRepo }: WikiEmptyStateProps) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 pb-12 text-center">
      <MascotStage spec={mascot} size={120} title={agentName} />
      <p className="mt-5 max-w-sm text-sm text-fg-muted">
        {agentName}'s wiki fills in as you work together — or teach it a codebase.
      </p>
      <Button variant="primary" className="mt-5" onClick={onLearnRepo}>
        Learn a repo
      </Button>
    </div>
  );
}
