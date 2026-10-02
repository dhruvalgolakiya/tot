import { Check } from "lucide-react";
import type { AppCatalogItem } from "@shared/types";
import { connectHint } from "../../lib/apps";
import { AppIcon } from "./AppIcon";

type AppCatalogCardProps = {
  item: AppCatalogItem;
  onConnect: () => void;
};

/** One app in the "Add apps" grid. Already-connected apps show a quiet check; clicking always starts connecting. */
export function AppCatalogCard({ item, onConnect }: AppCatalogCardProps) {
  const connected = item.accounts > 0;
  const hint = connectHint(item.connect);

  return (
    <button
      type="button"
      onClick={onConnect}
      className="flex items-start gap-3 rounded-xl border border-white/[0.07] bg-white/[0.02] p-3 text-left transition-colors hover:border-white/[0.14] hover:bg-white/[0.05]"
    >
      <AppIcon name={item.name} iconUrl={item.iconUrl} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-zinc-100">{item.name}</p>
        {item.description && <p className="mt-0.5 line-clamp-1 text-xs text-zinc-500">{item.description}</p>}
      </div>
      <span className="mt-0.5 shrink-0">
        {connected ? (
          <Check className="size-4 text-emerald-400" aria-label="Connected" />
        ) : (
          hint && <span className="text-[11px] font-medium text-zinc-500">{hint}</span>
        )}
      </span>
    </button>
  );
}
