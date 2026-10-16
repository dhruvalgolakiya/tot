import type { AppConnection } from "@tot/shared/types";
import { ledgerRowClass } from "../ui/Ledger";
import { StatusDot } from "../ui/StatusDot";
import { AppIcon } from "./AppIcon";

type AppRowProps = {
  connection: AppConnection;
  onOpen: () => void;
  onReconnect: () => void;
};

/** One connected account in "Your apps". Clicking the row opens its panel; the pill reconnects directly. */
export function AppRow({ connection, onOpen, onReconnect }: AppRowProps) {
  return (
    <li className="flex items-center gap-1">
      <button type="button" onClick={onOpen} className={ledgerRowClass({ interactive: true, className: "flex-1" })}>
        <span className="grid size-5 shrink-0 place-items-center">
          <AppIcon name={connection.name} iconUrl={connection.iconUrl} size="size-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-ui text-fg">{connection.name}</span>
          {connection.account && <span className="block truncate text-xs text-fg-subtle">{connection.account}</span>}
        </span>
      </button>
      {!connection.healthy && (
        <button
          type="button"
          onClick={onReconnect}
          className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-warning transition-opacity hover:opacity-80"
        >
          <StatusDot tone="amber" />
          Needs attention
        </button>
      )}
    </li>
  );
}
