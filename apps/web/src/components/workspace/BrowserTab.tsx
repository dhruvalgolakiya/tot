import { useCallback, useEffect, useState, type FormEvent } from "react";
import clsx from "clsx";
import { DropdownMenu } from "radix-ui";
import { ChevronDown, ExternalLink, Globe, RotateCw } from "lucide-react";
import type { Conversation } from "@tot/shared/types";
import type { WorkspaceInfo, WorkspaceServer } from "@tot/shared/workspace";
import { errorMessage } from "../../lib/api";
import { workspaceApi } from "../../lib/workspace";
import { Button } from "../ui/Button";
import { EmptyState } from "../ui/EmptyState";
import { IconButton } from "../ui/IconButton";
import { Tip } from "../ui/Tip";
import { useWorkspaceRefresh } from "./useWorkspaceRefresh";

const POLL_MS = 5000;

/** The page each chat showed last. */
const lastUrl = new Map<string, string>();

const onThisMac = () => ["localhost", "127.0.0.1", "[::1]", "::1"].includes(window.location.hostname);

/** What's typed in the address bar as a URL: http(s) only; a bare host or port is taken as localhost's. */
function toUrl(input: string): string | null {
  const text = input.trim();
  if (!text) return null;
  const withScheme = /^\d+$/.test(text) ? `http://localhost:${text}` : /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`;
  try {
    const url = new URL(withScheme);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function serverLabel(server: WorkspaceServer): string {
  return `localhost:${server.port}${server.command ? ` · ${server.command}` : ""}`;
}

/**
 * The chat folder's dev servers, previewed: the ones running from it (whoever started them) or printed by its
 * terminals, an address bar, reload and open in the browser. The page runs at its own address in a sandboxed
 * frame (it can't steer this window), so it keeps its own cookies and storage. This Mac only: on another device,
 * localhost would be that device.
 */
export function BrowserTab({ chat }: { chat: Conversation; info: WorkspaceInfo }) {
  const [servers, setServers] = useState<WorkspaceServer[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [url, setUrl] = useState<string | null>(() => lastUrl.get(chat.id) ?? null);
  const [typed, setTyped] = useState(url ?? "");
  const [frameKey, setFrameKey] = useState(0);
  const local = onThisMac();

  const load = useCallback(async () => {
    try {
      setServers(await workspaceApi.servers(chat.id));
      setProblem(null);
    } catch (error) {
      setProblem(errorMessage(error));
    }
  }, [chat.id]);

  useEffect(() => {
    if (!local) return;
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [load, local]);
  useWorkspaceRefresh(chat.id, () => void (local && load()));

  const go = (next: string) => {
    lastUrl.set(chat.id, next);
    setUrl(next);
    setTyped(next);
    setFrameKey((key) => key + 1);
  };

  // The first dev server, once there is one and nothing else was opened.
  useEffect(() => {
    if (!url && servers?.[0]) go(servers[0].url);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [servers, url]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const next = toUrl(typed);
    if (next) go(next);
  };

  if (!local) {
    return <EmptyState size="sm" icon={<Globe />} title="Previews open on this Mac" description="Dev servers in this folder answer on this Mac's own localhost." />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <form onSubmit={submit} className="flex h-10 shrink-0 items-center gap-0.5 border-b border-hairline pr-1.5 pl-1.5">
        <Tip content="Reload">
          <IconButton size="sm" label="Reload" disabled={!url} onClick={() => setFrameKey((key) => key + 1)}>
            <RotateCw />
          </IconButton>
        </Tip>
        <div className="flex h-7 min-w-0 flex-1 items-center rounded-md bg-fill-subtle pr-0.5 focus-within:bg-fill">
          <input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            placeholder="localhost:3000"
            aria-label="Address"
            spellCheck={false}
            className="h-full min-w-0 flex-1 bg-transparent px-2 font-mono text-xs text-fg outline-none placeholder:text-fg-subtle"
          />
          {servers && servers.length > 0 && (
            <DropdownMenu.Root>
              <Tip content="Dev servers in this folder">
                <DropdownMenu.Trigger asChild>
                  <IconButton size="sm" label="Dev servers in this folder" className="size-6">
                    <ChevronDown />
                  </IconButton>
                </DropdownMenu.Trigger>
              </Tip>
              <DropdownMenu.Portal>
                <DropdownMenu.Content className="menu w-64" sideOffset={4} align="end">
                  <DropdownMenu.Label className="menu-label">Running from this folder</DropdownMenu.Label>
                  {servers.map((server) => (
                    <DropdownMenu.Item key={server.port} className={clsx("menu-item font-mono text-xs", url?.startsWith(server.url) && "bg-selected")} onSelect={() => go(server.url)}>
                      {serverLabel(server)}
                    </DropdownMenu.Item>
                  ))}
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          )}
        </div>
        <Tip content="Open in your browser">
          <IconButton size="sm" label="Open in your browser" disabled={!url} onClick={() => url && window.open(url, "_blank", "noopener,noreferrer")}>
            <ExternalLink />
          </IconButton>
        </Tip>
      </form>
      {url ? (
        <iframe
          key={frameKey}
          src={url}
          title="Preview"
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
          className="min-h-0 w-full flex-1 bg-white"
        />
      ) : (
        <EmptyState
          size="sm"
          icon={<Globe />}
          title={servers === null && !problem ? "Looking for dev servers…" : "No dev server running"}
          description={problem ?? "Start one in this folder, in a terminal or by asking the agent, and it shows up here. Or type an address above."}
          action={
            servers === null ? undefined : (
              <Button size="sm" variant="ghost" onClick={() => void load()}>
                Look again
              </Button>
            )
          }
        />
      )}
    </div>
  );
}
