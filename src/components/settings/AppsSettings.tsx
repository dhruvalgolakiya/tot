import { useEffect, useRef, useState } from "react";
import { DropdownMenu } from "radix-ui";
import { Ellipsis, LoaderCircle, Power, Search } from "lucide-react";
import type { AppCatalogItem } from "@shared/types";
import { useAppConnect } from "../../hooks/useAppConnect";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { api, errorMessage } from "../../lib/api";
import { notifyError, setAppsStatus, useStore } from "../../store";
import { ConfirmDialog } from "../ConfirmDialog";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { AppCatalogCard } from "./AppCatalogCard";
import { AppConnectModal } from "./AppConnectModal";
import { AppPanel } from "./AppPanel";
import { AppRow } from "./AppRow";

const EXECUTOR_URL = "https://executor.sh";
const POLL_MS = 3_000;

/**
 * Gmail, Linear, Notion… connected once (via Executor, running privately on this
 * Mac) and shared by every agent, on both Claude and ChatGPT. Reads run freely;
 * writes pause for the user's OK on an approval card in the chat.
 */
export function AppsSettings() {
  const apps = useStore((s) => s.apps);
  const [busy, setBusy] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [panelAppId, setPanelAppId] = useState<string | null>(null);
  const pollTimer = useRef<number | undefined>(undefined);
  const state = apps?.state;

  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query.trim(), 200);
  const [catalog, setCatalog] = useState<AppCatalogItem[] | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  const { flow, start, retry, cancel, submitKey, submitClient } = useAppConnect();

  // Status arrives live via the "apps" AppEvent; this is just a fallback in
  // case that event is missed while Executor installs or starts.
  useEffect(() => {
    window.clearInterval(pollTimer.current);
    if (state !== "installing" && state !== "starting") return;
    pollTimer.current = window.setInterval(() => {
      api.getApps().then(setAppsStatus, () => {});
    }, POLL_MS);
    return () => window.clearInterval(pollTimer.current);
  }, [state]);

  // Popular apps (no q) on first load; re-runs whenever the status changes too,
  // so each card's "connected" check stays current.
  useEffect(() => {
    if (state !== "running") return;
    if (debouncedQuery.length === 1) return; // Below the 2-char minimum; keep showing the last results.
    let cancelled = false;
    setCatalogError(null);
    api.appsCatalog(debouncedQuery.length >= 2 ? debouncedQuery : undefined).then(
      (list) => {
        if (!cancelled) setCatalog(list);
      },
      (error: unknown) => {
        if (!cancelled) setCatalogError(errorMessage(error));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [state, debouncedQuery, apps]);

  async function setup() {
    setBusy(true);
    try {
      setAppsStatus(await api.setupApps());
    } catch (error) {
      notifyError(error);
    } finally {
      setBusy(false);
    }
  }

  async function stop() {
    try {
      setAppsStatus(await api.stopApps());
    } catch (error) {
      notifyError(error);
    }
  }

  const footnote = (
    <p className="mt-4 border-t border-white/[0.06] pt-3 text-xs text-zinc-500">
      <a href={EXECUTOR_URL} target="_blank" rel="noopener noreferrer" className="hover:text-zinc-300 hover:underline">
        Powered by Executor
      </a>
    </p>
  );

  if (!apps) {
    return <div className="h-28 animate-pulse rounded-xl bg-white/[0.03]" aria-label="Loading Apps status" />;
  }

  return (
    <div className="rounded-xl border border-white/[0.07] bg-white/[0.02] p-4">
      {(apps.state === "not-installed" || apps.state === "stopped") && (
        <div className="space-y-1.5">
          <Button variant="primary" size="sm" onClick={() => void setup()} disabled={busy}>
            {busy && <LoaderCircle className="animate-spin" />}
            {apps.state === "stopped" ? "Turn on" : "Set up"}
          </Button>
          {apps.state === "not-installed" && (
            <p className="text-xs text-zinc-500">Installs Executor (open source, ~90 MB) on this Mac</p>
          )}
        </div>
      )}

      {(apps.state === "installing" || apps.state === "starting") && (
        <div className="flex items-center gap-2 text-sm text-zinc-400">
          <LoaderCircle className="size-4 animate-spin text-[var(--agent-accent)]" />
          {apps.state === "installing" ? "Installing Executor…" : "Starting…"}
        </div>
      )}

      {apps.state === "error" && (
        <div className="space-y-2">
          <p className="rounded-lg bg-red-500/[0.08] px-3 py-2 text-xs text-red-300">{apps.error}</p>
          <Button variant="secondary" size="sm" onClick={() => void setup()} disabled={busy}>
            {busy ? "Trying again…" : "Try again"}
          </Button>
        </div>
      )}

      {apps.state === "running" && (
        <div className="space-y-5">
          <section>
            <h3 className="label-caps mb-2">Your apps</h3>
            {apps.apps.length === 0 ? (
              <p className="text-sm text-zinc-500">Add an app below to let agents use it.</p>
            ) : (
              <ul className="space-y-1.5">
                {apps.apps.map((connection) => (
                  <AppRow
                    key={connection.id}
                    connection={connection}
                    onOpen={() => setPanelAppId(connection.appId)}
                    onReconnect={() => start(connection.appId, connection.name)}
                  />
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3 className="label-caps mb-2">Add apps</h3>
            <div className="relative mb-2.5">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-zinc-500" />
              <input
                type="text"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search apps"
                aria-label="Search apps"
                className="input pl-9"
              />
            </div>

            {catalogError && (
              <p className="rounded-lg border border-white/[0.07] px-3 py-4 text-center text-sm text-zinc-500">{catalogError}</p>
            )}
            {!catalog && !catalogError && (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" aria-label="Loading apps">
                {[0, 1, 2, 3].map((key) => (
                  <div key={key} className="h-[52px] animate-pulse rounded-xl bg-white/[0.03]" />
                ))}
              </div>
            )}
            {catalog && catalog.length === 0 && (
              <p className="rounded-xl border border-dashed border-white/10 px-4 py-6 text-center text-sm text-zinc-500">
                No apps match “{debouncedQuery}”.
              </p>
            )}
            {catalog && catalog.length > 0 && (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {catalog.map((item) => (
                  <AppCatalogCard key={item.appId} item={item} onConnect={() => start(item.appId, item.name, item.connect === "sign-in")} />
                ))}
              </div>
            )}
          </section>

          <div className="flex justify-end border-t border-white/[0.06] pt-3">
            <DropdownMenu.Root modal={false}>
              <DropdownMenu.Trigger asChild>
                <IconButton label="More Apps options" size="sm">
                  <Ellipsis />
                </IconButton>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content align="end" sideOffset={4} className="menu w-44">
                  <DropdownMenu.Item
                    className="menu-item text-red-400 data-[highlighted]:bg-red-500/10"
                    onSelect={() => setConfirmOpen(true)}
                  >
                    <Power className="size-4" /> Turn off
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
        </div>
      )}

      {footnote}

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Turn off Apps?"
        description="Agents lose access to your apps until you turn them back on."
        confirmLabel="Turn off"
        onConfirm={() => void stop()}
      />

      <AppConnectModal flow={flow} onCancel={cancel} onRetry={retry} onSubmitKey={submitKey} onSubmitClient={submitClient} />
      <AppPanel appId={panelAppId} onClose={() => setPanelAppId(null)} />
    </div>
  );
}
