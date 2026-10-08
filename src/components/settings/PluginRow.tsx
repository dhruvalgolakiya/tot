import { useState } from "react";
import { DropdownMenu } from "radix-ui";
import { Ellipsis, Puzzle, Trash } from "lucide-react";
import type { Plugin } from "@shared/types";
import { api } from "../../lib/api";
import { PROVIDER_LABELS } from "../../lib/models";
import { pluginTarget } from "../../lib/plugins";
import { notifyError } from "../../store";
import { ConfirmDialog } from "../ConfirmDialog";
import { Chip } from "../ui/Chip";
import { IconButton } from "../ui/IconButton";
import { ledgerRowClass } from "../ui/Ledger";
import { Switch } from "../ui/Switch";

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
    <>
      <div className={ledgerRowClass({ className: "items-start gap-3 py-2" })}>
        <Puzzle className="mt-0.5 size-4 shrink-0 text-fg-subtle" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-ui text-fg">{plugin.name}</span>
            <Chip>{plugin.config.type}</Chip>
            {plugin.providers.map((provider) => (
              <Chip key={provider}>{PROVIDER_LABELS[provider]}</Chip>
            ))}
          </div>
          {plugin.description && <p className="mt-1 text-xs text-fg-muted">{plugin.description}</p>}
          <p className="mt-1 truncate font-mono text-2xs text-fg-subtle" title={target}>
            {target}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2 pt-0.5">
          <Switch checked={plugin.enabled} onCheckedChange={(enabled) => void setEnabled(enabled)} disabled={busy} label={`Enable ${plugin.name}`} />
          <DropdownMenu.Root modal={false}>
            <DropdownMenu.Trigger asChild>
              <IconButton label={`More options for ${plugin.name}`} size="sm">
                <Ellipsis />
              </IconButton>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content align="end" sideOffset={4} className="menu w-44">
                <DropdownMenu.Item className="menu-item menu-item-danger" disabled={busy} onSelect={() => setConfirming(true)}>
                  <Trash className="size-4" /> Delete
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Delete plugin?"
        description={`Removes ${plugin.name} and its tools from TOT.`}
        confirmLabel="Delete"
        onConfirm={() => void remove()}
      />
    </>
  );
}
