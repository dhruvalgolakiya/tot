import { useEffect, useState } from "react";
import { Plus } from "lucide-react";
import type { Plugin } from "@shared/types";
import { api, errorMessage } from "../../lib/api";
import { Button } from "../ui/Button";
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
    <div className="space-y-4">
      <p className="text-sm leading-relaxed text-zinc-400">
        TOT's computer, memory and GitHub tools are built in. Add other MCP servers here for more tools, like Linear or your own APIs.
      </p>

      {loadError && (
        <p className="rounded-lg border border-white/[0.07] px-3 py-4 text-center text-sm text-zinc-500">
          {loadError}{" "}
          <button type="button" onClick={load} className="font-medium text-zinc-300 hover:underline">
            Retry
          </button>
        </p>
      )}

      {!plugins && !loadError && <div className="h-20 animate-pulse rounded-xl bg-white/[0.03]" aria-label="Loading plugins" />}

      {plugins && plugins.length === 0 && !adding && (
        <p className="rounded-xl border border-dashed border-white/10 px-4 py-6 text-center text-sm text-zinc-500">
          No plugins yet. Add an MCP server to give TOT new tools.
        </p>
      )}

      {plugins && plugins.length > 0 && (
        <ul className="space-y-2">
          {plugins.map((plugin) => (
            <PluginRow key={plugin.id} plugin={plugin} onChanged={replace} onDeleted={remove} />
          ))}
        </ul>
      )}

      {adding ? (
        <PluginForm
          existingNames={plugins?.map((p) => p.name) ?? []}
          onCreated={(plugin) => {
            setPlugins((list) => [...(list ?? []), plugin]);
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      ) : (
        <Button onClick={() => setAdding(true)} disabled={!plugins}>
          <Plus /> Add plugin
        </Button>
      )}
    </div>
  );
}
