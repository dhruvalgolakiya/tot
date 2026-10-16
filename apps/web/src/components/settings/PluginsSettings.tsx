import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import type { Plugin } from "@tot/shared/types";
import { api, errorMessage } from "../../lib/api";
import { Button } from "../ui/Button";
import { Callout } from "../ui/Callout";
import { EmptyState } from "../ui/EmptyState";
import { LedgerGroup, LedgerHeader } from "../ui/Ledger";
import { Skeleton } from "../ui/Skeleton";
import { PluginForm } from "./PluginForm";
import { PluginRow } from "./PluginRow";

/** Other MCP servers, on top of TOT's built-in computer, memory and GitHub tools. Changes apply immediately, no Save button. */
export function PluginsSettings() {
  const [plugins, setPlugins] = useState<Plugin[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  function load() {
    setLoadError(null);
    api.listPlugins().then(setPlugins, (error: unknown) => setLoadError(errorMessage(error)));
  }

  useEffect(load, []);

  const replace = (plugin: Plugin) => setPlugins((list) => list?.map((p) => (p.id === plugin.id ? plugin : p)) ?? null);
  const remove = (id: string) => setPlugins((list) => list?.filter((p) => p.id !== id) ?? null);

  return (
    <div className="space-y-8">
      <p className="text-sm leading-relaxed text-fg-muted">
        TOT's computer, memory and GitHub tools are built in. Add other MCP servers here for more tools, like Linear or your own APIs.
      </p>

      {loadError && (
        <Callout
          tone="danger"
          action={
            <button type="button" onClick={load} className="link-muted">
              Retry
            </button>
          }
        >
          {loadError}
        </Callout>
      )}

      <LedgerGroup
        body="rows"
        header={
          <LedgerHeader
            title="Plugins"
            meta={plugins ? `${plugins.length}` : undefined}
            action={
              <Button size="sm" variant="secondary" onClick={() => setAdding(true)} disabled={!plugins || adding}>
                <Plus /> Add plugin
              </Button>
            }
          />
        }
      >
        {!plugins && !loadError && (
          <div className="p-1" aria-busy="true" aria-label="Loading plugins">
            <Skeleton className="h-14 w-full rounded-lg" />
          </div>
        )}

        {plugins && plugins.length === 0 && !adding && (
          <EmptyState variant="quiet" title="No plugins yet" description="Add an MCP server to give TOT new tools." />
        )}

        {plugins?.map((plugin) => <PluginRow key={plugin.id} plugin={plugin} onChanged={replace} onDeleted={remove} />)}
      </LedgerGroup>

      {adding && (
        <PluginForm
          existingNames={plugins?.map((p) => p.name) ?? []}
          onCreated={(plugin) => {
            setPlugins((list) => [...(list ?? []), plugin]);
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      )}
    </div>
  );
}
