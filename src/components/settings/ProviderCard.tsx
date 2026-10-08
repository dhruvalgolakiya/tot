import type { ReactNode } from "react";
import clsx from "clsx";
import type { ProviderId, ProviderStatus } from "@shared/types";
import { PROVIDER_LABELS } from "../../lib/models";
import { Badge } from "../ui/Badge";
import { Callout } from "../ui/Callout";
import { Chip } from "../ui/Chip";
import { LedgerField, LedgerGroup } from "../ui/Ledger";
import { TickText } from "../ui/TickText";
import { Tip } from "../ui/Tip";

type ProviderCardProps = {
  id: ProviderId;
  provider: ProviderStatus | undefined;
  /** Top-right action, e.g. a Connect button. */
  action?: ReactNode;
  /** `LedgerField`s for this subscription's settings. */
  children?: ReactNode;
};

/** One subscription as a ledger group: its name and login state above the panel, then its models and settings. */
export function ProviderCard({ id, provider, action, children }: ProviderCardProps) {
  const label = provider?.label ?? PROVIDER_LABELS[id];
  const loggedIn = provider?.loggedIn ?? false;
  const account = [provider?.authMethod, provider?.account].filter(Boolean).join(" · ");
  const subtitle = account || (provider && !provider.installed ? "Not installed on this machine" : "");
  const models = provider?.models ?? [];

  return (
    <LedgerGroup
      title={
        <span className="flex items-center gap-2">
          {label}
          <Badge tone={loggedIn ? "success" : "neutral"} dot>
            {provider ? (loggedIn ? "Connected" : "Not connected") : "Unknown"}
          </Badge>
        </span>
      }
      description={subtitle || undefined}
      action={action}
    >
      {provider?.detail && (
        <div className="px-4 py-3">
          <Callout tone="info">
            <span className="whitespace-pre-line">
              <TickText text={provider.detail} />
            </span>
          </Callout>
        </div>
      )}
      {models.length > 0 && (
        <LedgerField
          title="Models"
          description={`${models.filter((m) => m.available).length} of ${models.length} available on your plan.`}
          stacked
          control={
            <div className="flex flex-wrap gap-1.5">
              {models.map((model) => (
                <Tip key={model.id} content={model.available ? model.description : model.unavailableReason}>
                  <span tabIndex={0} className="inline-flex">
                    <Chip className={clsx(!model.available && "opacity-50")}>{model.label}</Chip>
                  </span>
                </Tip>
              ))}
            </div>
          }
        />
      )}
      {children}
    </LedgerGroup>
  );
}
