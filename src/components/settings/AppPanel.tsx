import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import type { AppRule } from "@shared/types";
import { api, errorMessage } from "../../lib/api";
import { humanizeAppTool } from "../../lib/apps";
import { notifyError, setAppsStatus, useStore } from "../../store";
import { ConfirmDialog } from "../ConfirmDialog";
import { AppIcon } from "./AppIcon";
import { AppRuleRow } from "./AppRuleRow";
import { Modal } from "../ui/Modal";

const PAGE_SIZE = 50;

type AppPanelProps = {
  /** Null keeps the modal mounted (for its close animation) but closed. */
  appId: string | null;
  onClose: () => void;
};

/** A connected app: icon/name/account(s), its approval rules, and Disconnect. */
export function AppPanel({ appId, onClose }: AppPanelProps) {
  const apps = useStore((s) => s.apps);
  const connections = appId ? (apps?.apps.filter((c) => c.appId === appId) ?? []) : [];
  const [rules, setRules] = useState<AppRule[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

  useEffect(() => {
    if (!appId) return;
    setRules(null);
    setLoadError(null);
    setQuery("");
    setVisible(PAGE_SIZE);
    api.appRules(appId).then(setRules, (error: unknown) => setLoadError(errorMessage(error)));
  }, [appId]);

  // The app was disconnected elsewhere (another tab, or a live "apps" event) while the panel was open.
  useEffect(() => {
    if (appId && apps && connections.length === 0) onClose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appId, apps, connections.length]);

  const first = connections[0];
  const name = first?.name ?? "App";
  const accountText = connections
    .map((c) => c.account)
    .filter((a): a is string => Boolean(a))
    .join(", ");

  const [appRule, ...actionRules] = rules ?? [];
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return actionRules;
    return actionRules.filter(
      (rule) => humanizeAppTool(rule.tool).toLowerCase().includes(q) || rule.tool.toLowerCase().includes(q) || rule.description.toLowerCase().includes(q),
    );
  }, [actionRules, query]);
  const shown = filtered.slice(0, visible);

  async function disconnect() {
    if (!appId) return;
    setDisconnecting(true);
    try {
      setAppsStatus(await api.removeApp(appId));
      onClose();
    } catch (error) {
      notifyError(error);
    } finally {
      setDisconnecting(false);
    }
  }

  return (
    <Modal
      open={appId !== null}
      onOpenChange={(open) => !open && onClose()}
      title={
        <div className="flex items-center gap-2.5">
          <AppIcon name={name} iconUrl={first?.iconUrl ?? null} size="size-7" />
          {name}
        </div>
      }
      description={accountText || undefined}
      className="max-w-lg"
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-4">
          {loadError && <p className="rounded-lg border border-white/[0.07] px-3 py-4 text-center text-sm text-zinc-500">{loadError}</p>}
          {!rules && !loadError && <div className="h-40 animate-pulse rounded-xl bg-white/[0.03]" aria-label="Loading approval rules" />}

          {appId && rules && (
            <div className="space-y-3">
              <p className="label-caps">Approval rules</p>

              {appRule && (
                <ul className="rounded-xl border border-white/[0.07]">
                  <AppRuleRow rule={appRule} appId={appId} onChanged={setRules} />
                </ul>
              )}

              {actionRules.length > 0 && (
                <div className="relative">
                  <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-zinc-500" />
                  <input
                    type="text"
                    value={query}
                    onChange={(event) => {
                      setQuery(event.target.value);
                      setVisible(PAGE_SIZE);
                    }}
                    placeholder="Search actions"
                    aria-label="Search actions"
                    className="input pl-9"
                  />
                </div>
              )}

              {actionRules.length > 0 && (
                <ul className="divide-y divide-white/[0.06] rounded-xl border border-white/[0.07]">
                  {shown.map((rule) => (
                    <AppRuleRow key={rule.tool} rule={rule} appId={appId} onChanged={setRules} />
                  ))}
                  {shown.length === 0 && (
                    <li className="px-3.5 py-6 text-center text-sm text-zinc-500">No actions match “{query}”.</li>
                  )}
                </ul>
              )}

              {filtered.length > shown.length && (
                <button
                  type="button"
                  onClick={() => setVisible((v) => v + PAGE_SIZE)}
                  className="text-xs font-medium text-zinc-400 hover:text-zinc-200"
                >
                  Show more ({filtered.length - shown.length} more)
                </button>
              )}
            </div>
          )}
        </div>

        <div className="flex shrink-0 items-center justify-end border-t border-white/[0.06] px-5 py-3.5">
          <button
            type="button"
            onClick={() => setConfirmOpen(true)}
            disabled={disconnecting}
            className="text-xs font-medium text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline disabled:pointer-events-none disabled:opacity-50"
          >
            {disconnecting ? "Disconnecting…" : "Disconnect"}
          </button>
        </div>
      </div>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={`Disconnect ${name}?`}
        description={`Agents lose access to ${name}. Its sign-in and rules are removed.`}
        confirmLabel="Disconnect"
        onConfirm={() => void disconnect()}
      />
    </Modal>
  );
}
