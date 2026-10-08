import { useEffect, useState } from "react";
import { IdCard, Plus } from "lucide-react";
import { loadPersonas, useLocalAgents, useStore } from "../../store";
import { Button } from "../ui/Button";
import { Callout } from "../ui/Callout";
import { EmptyState } from "../ui/EmptyState";
import { LedgerGroup, LedgerHeader } from "../ui/Ledger";
import { Skeleton } from "../ui/Skeleton";
import { PersonaDetail } from "./PersonaDetail";
import { PersonaFormModal } from "./PersonaFormModal";
import { PersonaRow } from "./PersonaRow";

/** Settings → Personas: the list of identities agents can work as, and (clicking one) its own sub-page. */
export function PersonasSettings() {
  const personas = useStore((s) => s.personas);
  const personasState = useStore((s) => s.personasState);
  const agents = useLocalAgents();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const selected = selectedId ? personas.find((p) => p.id === selectedId) : undefined;

  // The selected persona was deleted elsewhere (another tab, or a live event): fall back to the list.
  useEffect(() => {
    if (selectedId && personasState === "ready" && !selected) setSelectedId(null);
  }, [selectedId, personasState, selected]);

  if (selected) return <PersonaDetail persona={selected} onBack={() => setSelectedId(null)} />;

  return (
    <div className="space-y-8">
      {personasState === "error" && (
        <Callout tone="danger" action={<button type="button" onClick={() => void loadPersonas()} className="link-muted">Try again</button>}>
          Couldn't load personas.
        </Callout>
      )}

      <LedgerGroup
        body="rows"
        header={
          <LedgerHeader
            title="Personas"
            meta={personasState === "ready" ? `${personas.length}` : undefined}
            action={
              <Button variant="secondary" size="sm" onClick={() => setCreating(true)}>
                <Plus /> New persona
              </Button>
            }
          />
        }
      >
        {personasState === "loading" && (
          <div className="space-y-1 p-1" aria-busy="true" aria-label="Loading personas">
            {[0, 1].map((key) => (
              <Skeleton key={key} className="h-9 w-full rounded-lg" />
            ))}
          </div>
        )}

        {personasState !== "loading" && personas.length === 0 && (
          <EmptyState
            variant="quiet"
            icon={<IdCard />}
            title="No personas yet"
            description="Give an agent its own email so its sign-ups, emails and commits show up as the agent, not you."
          />
        )}

        {personas.map((persona) => (
          <PersonaRow key={persona.id} persona={persona} agents={agents} onClick={() => setSelectedId(persona.id)} />
        ))}
      </LedgerGroup>

      <PersonaFormModal open={creating} onOpenChange={setCreating} persona={null} onCreated={(persona) => setSelectedId(persona.id)} />
    </div>
  );
}
