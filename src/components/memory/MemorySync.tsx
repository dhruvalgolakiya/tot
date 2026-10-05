import { useEffect, useState, type FormEvent } from "react";
import clsx from "clsx";
import { Laptop, RefreshCw } from "lucide-react";
import type { MemoryPeerSync, MemorySyncStatus } from "@shared/types";
import { api } from "../../lib/api";
import { relativeTime } from "../../lib/format";
import { goToSettings, notifyError, saveSettings, useStore } from "../../store";
import { SettingRow } from "../settings/SettingRow";
import { Button } from "../ui/Button";
import { cardClass } from "../ui/Card";
import { SectionHeader } from "../ui/SectionHeader";
import { StatusDot } from "../ui/StatusDot";
import { Switch } from "../ui/Switch";

/**
 * Sync (roadmap module 10): "About you" follows you to your paired devices, no GitHub needed; and the optional
 * backup to a private git remote. Project memory stays on its device.
 */
export function MemorySync({ sync, onChanged }: { sync: MemorySyncStatus; onChanged: () => void }) {
  const remote = useStore((s) => s.settings?.memory.remote);
  const [url, setUrl] = useState(remote?.url ?? "");
  const [syncing, setSyncing] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => setUrl(remote?.url ?? ""), [remote?.url]);
  if (!remote) return null;

  async function syncNow() {
    setSyncing(true);
    try {
      await api.syncMemory();
      onChanged();
    } catch (error) {
      notifyError(error);
    } finally {
      setSyncing(false);
    }
  }

  async function saveUrl(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    // Clearing the URL turns the backup off too.
    if (await saveSettings({ memory: { remote: { url: url.trim(), ...(url.trim() ? {} : { enabled: false }) } } })) onChanged();
    setSaving(false);
  }

  const { remote: status } = sync;
  const urlChanged = url.trim() !== remote.url;

  return (
    <section className="space-y-3">
      <SectionHeader
        title="Sync"
        description="About you follows you to the devices you paired, no GitHub needed. Project memory stays on its device."
        action={
          sync.peers.length > 0 || remote.enabled ? (
            <Button size="sm" variant="secondary" disabled={syncing} onClick={() => void syncNow()}>
              <RefreshCw className={clsx(syncing && "animate-spin")} /> {syncing ? "Syncing…" : "Sync now"}
            </Button>
          ) : undefined
        }
      />
      {sync.peers.length ? (
        <ul className={cardClass({ padding: "none" })}>
          {sync.peers.map((peer, index) => (
            <PeerRow key={peer.deviceId} peer={peer} first={index === 0} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-fg-muted">
          No paired devices yet.{" "}
          <button type="button" className="link" onClick={() => goToSettings("devices")}>
            Pair one
          </button>{" "}
          and this memory follows you there.
        </p>
      )}

      <div className={cardClass({ padding: "none", className: "divide-y divide-hairline" })}>
        <SettingRow
          className="px-4"
          htmlFor="memory-remote"
          title="Back up to a git remote"
          description="Optional: a private repo you made. TOT pulls and pushes it after changes, with this computer's SSH keys. Turn it on on one device."
          control={
            <Switch
              id="memory-remote"
              checked={remote.enabled}
              disabled={!remote.url}
              onCheckedChange={(enabled) => void saveSettings({ memory: { remote: { enabled } } }).then(onChanged)}
            />
          }
        />
        <form onSubmit={(event) => void saveUrl(event)} className="space-y-1.5 px-4 py-3">
          <label htmlFor="memory-remote-url" className="block text-sm font-medium text-fg">
            Remote URL
          </label>
          <div className="flex gap-2">
            <input
              id="memory-remote-url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="git@github.com:you/memory.git"
              spellCheck={false}
              autoComplete="off"
              className="input input-sm min-w-0 flex-1 font-mono"
            />
            {urlChanged && (
              <Button type="submit" size="sm" variant="primary" disabled={saving}>
                {saving ? "Saving…" : "Save"}
              </Button>
            )}
          </div>
          <p className={clsx("text-xs", status.error ? "text-danger" : "text-fg-subtle")}>
            {status.error
              ? status.error
              : status.lastPushAt
                ? `Last pushed ${relativeTime(status.lastPushAt)}`
                : remote.enabled
                  ? "Not pushed yet."
                  : "Off. Nothing leaves this computer except to your paired devices."}
          </p>
        </form>
      </div>
    </section>
  );
}

function peerLine(peer: MemoryPeerSync): string {
  if (peer.error) return peer.error;
  if (peer.lastSyncAt) return `Synced ${relativeTime(peer.lastSyncAt)}${peer.online ? "" : " · offline now"}`;
  return peer.online ? "Not synced yet" : "Offline";
}

function PeerRow({ peer, first }: { peer: MemoryPeerSync; first: boolean }) {
  return (
    <li className={clsx("flex min-h-14 items-center gap-3 px-4 py-2.5", !first && "border-t border-hairline")}>
      <span className="relative shrink-0">
        <Laptop className="size-4 text-fg-subtle" />
        <span className="absolute -right-1 -bottom-0.5">
          <StatusDot tone={peer.error ? "red" : peer.online ? "green" : "gray"} />
        </span>
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-fg">{peer.name}</p>
        <p className={clsx("truncate text-xs", peer.error ? "text-danger" : "text-fg-subtle")}>{peerLine(peer)}</p>
      </div>
    </li>
  );
}
