import { useState } from "react";
import { DropdownMenu } from "radix-ui";
import { Check, Ellipsis, LogIn, Pencil, Power, Trash } from "lucide-react";
import type { AccountStatus } from "@shared/types";
import { ConfirmDialog } from "../ConfirmDialog";
import { Badge, type BadgeTone } from "../ui/Badge";
import { IconButton } from "../ui/IconButton";
import { ledgerRowClass } from "../ui/Ledger";

type AccountRowProps = {
  account: AccountStatus;
  /** Another account of this provider exists, so the one Auto uses is worth marking. */
  several: boolean;
  signingIn: boolean;
  onRename: () => void;
  onToggleTools: (on: boolean) => void;
  onToggleEnabled: (on: boolean) => void;
  onSignIn: () => void;
  onRemove: () => void;
};

/** Where an account stands, as one badge: off, signed in (or through a proxy), or not signed in. */
function state(account: AccountStatus): { label: string; tone: BadgeTone } {
  if (!account.enabled) return { label: "Off", tone: "neutral" };
  if (account.limitedUntil) return { label: "At its limit", tone: "warning" };
  if (account.loggedIn) return { label: account.proxy ? "Proxy" : "Signed in", tone: "success" };
  return { label: "Not signed in", tone: "neutral" };
}

/** "Linear, Slack and 6 more". */
function names(list: string[]): string {
  if (list.length <= 3) return list.join(", ");
  return `${list.slice(0, 2).join(", ")} and ${list.length - 2} more`;
}

/** One provider account: its name, folder, sign-in and what it brings; everything else in its "…" menu. */
export function AccountRow({ account, several, signingIn, onRename, onToggleTools, onToggleEnabled, onSignIn, onRemove }: AccountRowProps) {
  const [confirming, setConfirming] = useState(false);
  const badge = state(account);
  const who = [account.authMethod, account.email].filter(Boolean).join(" · ");
  // Key names only: the values never reach the browser.
  const proxyNote = account.proxy ? `Uses a proxy: ${account.envKeys.filter((key) => key.startsWith("ANTHROPIC_")).slice(0, 2).join(", ")} set` : "";
  const tools = account.useAccountTools
    ? [account.mcpServers.length ? `MCP: ${names(account.mcpServers)}` : "", account.plugins.length ? `Plugins: ${names(account.plugins)}` : ""].filter(Boolean).join(" · ")
    : account.mcpServers.length
      ? `${account.mcpServers.length} MCP server${account.mcpServers.length === 1 ? "" : "s"}, not used`
      : "";
  const lines = [proxyNote || who, tools].filter(Boolean);
  const problem = account.enabled && !account.loggedIn && account.detail ? account.detail : "";

  return (
    <>
      <div className={ledgerRowClass({ className: "items-start gap-3 py-2.5" })}>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-ui font-medium text-fg">{account.name}</span>
            {several && account.isDefault && account.enabled && <Badge>Auto & tasks</Badge>}
          </div>
          <p className="mt-0.5 truncate font-mono text-2xs text-fg-subtle" title={account.dir}>
            {account.dir}
          </p>
          {lines.map((line) => (
            <p key={line} className="mt-1 truncate text-xs text-fg-subtle" title={line}>
              {line}
            </p>
          ))}
          {problem && <p className="mt-1 text-xs leading-relaxed text-fg-subtle">{problem}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2 pt-0.5">
          <Badge tone={badge.tone} dot>
            {signingIn ? "Signing in…" : badge.label}
          </Badge>
          <DropdownMenu.Root modal={false}>
            <DropdownMenu.Trigger asChild>
              <IconButton label={`More options for ${account.name}`} size="sm">
                <Ellipsis />
              </IconButton>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content align="end" sideOffset={4} className="menu w-64">
                <DropdownMenu.Item className="menu-item" onSelect={onRename}>
                  <Pencil className="size-4 text-fg-muted" /> Rename…
                </DropdownMenu.Item>
                <DropdownMenu.Item className="menu-item" disabled={!account.enabled || signingIn} onSelect={onSignIn}>
                  <LogIn className="size-4 text-fg-muted" /> {account.loggedIn ? "Sign in again…" : "Sign in…"}
                </DropdownMenu.Item>
                <DropdownMenu.CheckboxItem
                  className="menu-item"
                  checked={account.useAccountTools}
                  onCheckedChange={onToggleTools}
                >
                  <span className="grid size-4 place-items-center">
                    <DropdownMenu.ItemIndicator>
                      <Check className="size-4 text-fg" />
                    </DropdownMenu.ItemIndicator>
                  </span>
                  Use this account's MCP servers
                </DropdownMenu.CheckboxItem>
                <DropdownMenu.Item className="menu-item" onSelect={() => onToggleEnabled(!account.enabled)}>
                  <Power className="size-4 text-fg-muted" /> {account.enabled ? "Turn off" : "Turn on"}
                </DropdownMenu.Item>
                {!account.builtIn && (
                  <>
                    <DropdownMenu.Separator className="menu-separator" />
                    <DropdownMenu.Item className="menu-item menu-item-danger" onSelect={() => setConfirming(true)}>
                      <Trash className="size-4" /> Remove
                    </DropdownMenu.Item>
                  </>
                )}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      </div>

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Remove account?"
        description={`TOT stops using ${account.name}. Its folder (${account.dir}) and sign-in stay as they are.`}
        confirmLabel="Remove"
        onConfirm={onRemove}
      />
    </>
  );
}
