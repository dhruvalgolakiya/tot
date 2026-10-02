import { Check } from "lucide-react";
import type { AppCatalogItem } from "@shared/types";
import { connectHint } from "../../lib/apps";
import { cardClass } from "../ui/Card";
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
      className={cardClass({ padding: "sm", interactive: true, className: "flex items-start gap-3" })}
    >
      <AppIcon name={item.name} iconUrl={item.iconUrl} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-fg">{item.name}</p>
        {item.description && <p className="mt-0.5 line-clamp-1 text-xs text-fg-subtle">{item.description}</p>}
      </div>
      <span className="mt-0.5 shrink-0">
        {connected ? (
          <Check className="size-4 text-success" aria-label="Connected" />
        ) : (
          hint && <span className="text-2xs font-medium text-fg-subtle">{hint}</span>
        )}
      </span>
    </button>
  );
}
