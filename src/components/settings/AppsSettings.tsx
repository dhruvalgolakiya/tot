import { useEffect, useRef, useState } from "react";
import { DropdownMenu } from "radix-ui";
import { Ellipsis, LoaderCircle, Power } from "lucide-react";
import type { AppCatalogItem } from "@shared/types";
import { useAppConnect } from "../../hooks/useAppConnect";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { api, errorMessage } from "../../lib/api";
import { notifyError, setAppsStatus, useStore } from "../../store";
import { ConfirmDialog } from "../ConfirmDialog";
import { Button } from "../ui/Button";
import { Callout } from "../ui/Callout";
import { cardClass } from "../ui/Card";
import { EmptyState } from "../ui/EmptyState";
import { IconButton } from "../ui/IconButton";
import { SearchInput } from "../ui/SearchInput";
import { Skeleton } from "../ui/Skeleton";
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

  // Popular apps (no q) on first load, then search results. Only the query refetches:
  // which apps are connected comes from the live status below, so status updates
  // (several arrive while the page opens) never cancel a request in flight.
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
  }, [state, debouncedQuery]);

  const connectedCounts = new Map<string, number>();
  for (const connection of apps?.apps ?? []) {
    connectedCounts.set(connection.appId, (connectedCounts.get(connection.appId) ?? 0) + 1);
  }

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
    <p className="mt-4 border-t border-hairline pt-3 text-xs text-fg-subtle">
      <a href={EXECUTOR_URL} target="_blank" rel="noopener noreferrer" className="link-muted">
        Powered by Executor
      </a>
    </p>
  );

  if (!apps) {
    return (
      <div aria-busy="true" aria-label="Loading Apps status">
        <Skeleton className="h-28 w-full rounded-xl" />
      </div>
    );
  }

  return (
    <div className={cardClass()}>
      {(apps.state === "not-installed" || apps.state === "stopped") && (
        <div className="space-y-1.5">
          <Button variant="primary" size="sm" onClick={() => void setup()} disabled={busy}>
            {busy && <LoaderCircle className="animate-spin" />}
            {apps.state === "stopped" ? "Turn on" : "Set up"}
          </Button>
          {apps.state === "not-installed" && (
            <p className="text-xs text-fg-subtle">Installs Executor (open source, ~90 MB) on this Mac</p>
          )}
        </div>
      )}

      {(apps.state === "installing" || apps.state === "starting") && (
        <div className="flex items-center gap-2 text-sm text-fg-muted">
          <LoaderCircle className="size-4 animate-spin text-accent" />
          {apps.state === "installing" ? "Installing Executor…" : "Starting…"}
        </div>
      )}

      {apps.state === "error" && (
        <div className="space-y-2">
          <Callout tone="danger">{apps.error}</Callout>
          <Button variant="secondary" size="sm" onClick={() => void setup()} disabled={busy}>
            {busy ? "Trying again…" : "Try again"}
          </Button>
        </div>
      )}

      {apps.state === "running" && (
        <div className="space-y-5">
          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="group-label">Your apps</h3>
              <DropdownMenu.Root modal={false}>
                <DropdownMenu.Trigger asChild>
                  <IconButton label="More Apps options" size="sm">
                    <Ellipsis />
                  </IconButton>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content align="end" sideOffset={4} className="menu w-44">
                    <DropdownMenu.Item className="menu-item menu-item-danger" onSelect={() => setConfirmOpen(true)}>
                      <Power className="size-4" /> Turn off
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </div>
            {apps.apps.length === 0 ? (
              <p className="text-sm text-fg-subtle">Add an app below to let agents use it.</p>
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
            <h3 className="group-label mb-2">Add apps</h3>
            <SearchInput
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search apps"
              aria-label="Search apps"
              containerClassName="mb-2.5"
            />

            {catalogError && <Callout tone="danger">{catalogError}</Callout>}
            {!catalog && !catalogError && (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2" aria-busy="true" aria-label="Loading apps">
                {[0, 1, 2, 3].map((key) => (
                  <Skeleton key={key} className="h-14 rounded-xl" />
                ))}
              </div>
            )}
            {catalog && catalog.length === 0 && <EmptyState variant="dashed" size="sm" title={`No apps match “${debouncedQuery}”.`} />}
            {catalog && catalog.length > 0 && (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {catalog.map((item) => (
                  <AppCatalogCard
                    key={item.appId}
                    item={{ ...item, accounts: connectedCounts.get(item.appId) ?? 0 }}
                    onConnect={() => start(item.appId, item.name, item.connect === "sign-in")}
                  />
                ))}
              </div>
            )}
          </section>

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
