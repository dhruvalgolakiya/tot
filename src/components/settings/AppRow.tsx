import type { AppConnection } from "@shared/types";
import { StatusDot } from "../ui/StatusDot";
import { AppIcon } from "./AppIcon";

type AppRowProps = {
  connection: AppConnection;
  onOpen: () => void;
  onReconnect: () => void;
};

/** One connected account in "Your apps". Clicking the row opens its panel; the badge reconnects directly. */
export function AppRow({ connection, onOpen, onReconnect }: AppRowProps) {
  return (
    <li className="flex items-center gap-1 rounded-lg bg-fill-subtle transition-colors hover:bg-hover">
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-2 text-left">
        <AppIcon name={connection.name} iconUrl={connection.iconUrl} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-fg">{connection.name}</p>
          {connection.account && <p className="truncate text-xs text-fg-subtle">{connection.account}</p>}
        </div>
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
