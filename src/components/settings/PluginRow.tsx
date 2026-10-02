import { useState } from "react";
import { Puzzle, Trash } from "lucide-react";
import type { Plugin } from "@shared/types";
import { api } from "../../lib/api";
import { PROVIDER_LABELS } from "../../lib/models";
import { pluginTarget } from "../../lib/plugins";
import { notifyError } from "../../store";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { Switch } from "../ui/Switch";
import { Tip } from "../ui/Tip";

type PluginRowProps = {
  plugin: Plugin;
  onChanged: (plugin: Plugin) => void;
  onDeleted: (id: string) => void;
};

const badge = "rounded-md bg-white/[0.06] px-1.5 py-px text-[11px] font-medium text-zinc-400";

export function PluginRow({ plugin, onChanged, onDeleted }: PluginRowProps) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const target = pluginTarget(plugin.config);

  async function setEnabled(enabled: boolean) {
    setBusy(true);
    onChanged({ ...plugin, enabled });
    try {
      onChanged(await api.updatePlugin(plugin.id, { enabled }));
    } catch (error) {
      onChanged(plugin);
      notifyError(error);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await api.deletePlugin(plugin.id);
      onDeleted(plugin.id);
    } catch (error) {
      notifyError(error);
      setBusy(false);
    }
  }

  return (
    <li className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-3.5">
      <div className="flex items-start gap-3">
        <Puzzle className="mt-0.5 size-4 shrink-0 text-zinc-500" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-sm text-zinc-100">{plugin.name}</span>
            <span className={badge}>{plugin.config.type}</span>
            {plugin.providers.map((provider) => (
              <span key={provider} className={badge}>
                {PROVIDER_LABELS[provider]}
              </span>
            ))}
          </div>
          {plugin.description && <p className="mt-1 text-xs text-zinc-400">{plugin.description}</p>}
          <p className="mt-1 truncate font-mono text-xs text-zinc-500" title={target}>
            {target}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Switch
            checked={plugin.enabled}
            onCheckedChange={(enabled) => void setEnabled(enabled)}
            disabled={busy}
            label={`Enable ${plugin.name}`}
          />
          {!confirming && (
            <Tip content="Delete">
              <IconButton label={`Delete ${plugin.name}`} size="sm" onClick={() => setConfirming(true)} disabled={busy}>
                <Trash />
              </IconButton>
            </Tip>
          )}
        </div>
      </div>
      {confirming && (
        <div className="mt-3 flex items-center justify-end gap-2 border-t border-white/[0.06] pt-3">
          <span className="mr-auto text-xs text-zinc-400">Remove this plugin?</span>
          <Button size="sm" variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" variant="danger" onClick={() => void remove()} disabled={busy}>
            Delete
          </Button>
        </div>
      )}
    </li>
  );
}
