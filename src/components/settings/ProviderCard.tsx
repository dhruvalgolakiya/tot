import type { ReactNode } from "react";
import clsx from "clsx";
import type { ProviderId, ProviderStatus } from "@shared/types";
import { PROVIDER_LABELS } from "../../lib/models";
import { Badge } from "../ui/Badge";
import { Callout } from "../ui/Callout";
import { cardClass } from "../ui/Card";
import { TickText } from "../ui/TickText";
import { Tip } from "../ui/Tip";

type ProviderCardProps = {
  id: ProviderId;
  provider: ProviderStatus | undefined;
  /** Top-right action, e.g. a Connect button. */
  action?: ReactNode;
  children?: ReactNode;
};

/** Login state, account, server hints and models for one subscription. */
export function ProviderCard({ id, provider, action, children }: ProviderCardProps) {
  const label = provider?.label ?? PROVIDER_LABELS[id];
  const loggedIn = provider?.loggedIn ?? false;
  const account = [provider?.authMethod, provider?.account].filter(Boolean).join(" · ");
  const subtitle = account || (provider && !provider.installed ? "Not installed on this machine" : "");

  return (
    <section className={cardClass({ padding: "none" })}>
      <header className="flex items-start gap-3 p-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-medium text-fg">{label}</h3>
            <Badge tone={loggedIn ? "success" : "neutral"} dot>
              {provider ? (loggedIn ? "Connected" : "Not connected") : "Unknown"}
            </Badge>
          </div>
          {subtitle && <p className="mt-1 truncate text-xs text-fg-subtle">{subtitle}</p>}
        </div>
        {action}
      </header>

      {provider?.detail && (
        <div className="mx-4 mb-3">
          <Callout tone="info">
            <span className="whitespace-pre-line">
              <TickText text={provider.detail} />
            </span>
          </Callout>
        </div>
      )}

      {provider && provider.models.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-4 pb-4">
          {provider.models.map((model) => (
            <Tip key={model.id} content={model.available ? model.description : model.unavailableReason}>
              <span tabIndex={0}>
                <Badge tone="neutral" className={clsx(!model.available && "opacity-50")}>
                  {model.label}
                </Badge>
              </span>
            </Tip>
          ))}
        </div>
      )}

      {children && <div className="space-y-4 border-t border-hairline p-4">{children}</div>}
    </section>
  );
}
