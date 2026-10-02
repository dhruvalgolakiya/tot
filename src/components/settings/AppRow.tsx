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
    <li className="flex items-center gap-1 rounded-lg bg-white/[0.03] transition-colors hover:bg-white/[0.06]">
      <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-2 text-left">
        <AppIcon name={connection.name} iconUrl={connection.iconUrl} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm text-zinc-200">{connection.name}</p>
          {connection.account && <p className="truncate text-xs text-zinc-500">{connection.account}</p>}
        </div>
      </button>
      {!connection.healthy && (
        <button
          type="button"
          onClick={onReconnect}
          className="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-amber-300 transition-colors hover:text-amber-200"
        >
          <StatusDot tone="amber" />
          Needs attention
        </button>
      )}
    </li>
  );
}
