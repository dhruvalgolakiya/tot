import { useState } from "react";
import { Puzzle, Trash } from "lucide-react";
import type { Plugin } from "@shared/types";
import { api } from "../../lib/api";
import { PROVIDER_LABELS } from "../../lib/models";
import { pluginTarget } from "../../lib/plugins";
import { notifyError } from "../../store";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { cardClass } from "../ui/Card";
import { IconButton } from "../ui/IconButton";
import { Switch } from "../ui/Switch";
import { Tip } from "../ui/Tip";

type PluginRowProps = {
  plugin: Plugin;
  onChanged: (plugin: Plugin) => void;
  onDeleted: (id: string) => void;
};

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
    <li className={cardClass({ padding: "sm" })}>
      <div className="flex items-start gap-3">
        <Puzzle className="mt-0.5 size-4 shrink-0 text-fg-subtle" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-sm text-fg">{plugin.name}</span>
            <Badge>{plugin.config.type}</Badge>
            {plugin.providers.map((provider) => (
              <Badge key={provider}>{PROVIDER_LABELS[provider]}</Badge>
            ))}
          </div>
          {plugin.description && <p className="mt-1 text-xs text-fg-muted">{plugin.description}</p>}
          <p className="mt-1 truncate font-mono text-xs text-fg-subtle" title={target}>
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
        <div className="mt-3 flex items-center justify-end gap-2 border-t border-hairline pt-3">
          <span className="mr-auto text-xs text-fg-muted">Remove this plugin?</span>
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
