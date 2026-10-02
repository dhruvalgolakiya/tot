import type { ReactNode } from "react";
import clsx from "clsx";
import type { ProviderId, ProviderStatus } from "@shared/types";
import { PROVIDER_LABELS } from "../../lib/models";
import { StatusDot } from "../ui/StatusDot";
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
    <section className="rounded-2xl border border-white/[0.07] bg-white/[0.02]">
      <header className="flex items-start gap-3 p-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-zinc-100">{label}</h3>
            <span
              className={clsx(
                "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium",
                loggedIn ? "bg-emerald-400/10 text-emerald-300" : "bg-white/[0.05] text-zinc-400",
              )}
            >
              <StatusDot tone={loggedIn ? "green" : "gray"} />
              {provider ? (loggedIn ? "Connected" : "Not connected") : "Unknown"}
            </span>
          </div>
          {subtitle && <p className="mt-1 truncate text-xs text-zinc-500">{subtitle}</p>}
        </div>
        {action}
      </header>

      {provider?.detail && (
        <p className="mx-4 mb-3 rounded-lg bg-white/[0.03] px-3 py-2 text-xs leading-relaxed whitespace-pre-line text-zinc-400">
          <TickText text={provider.detail} />
        </p>
      )}

      {provider && provider.models.length > 0 && (
        <div className="flex flex-wrap gap-1.5 px-4 pb-4">
          {provider.models.map((model) => (
            <Tip key={model.id} content={model.available ? model.description : model.unavailableReason}>
              <span
                tabIndex={0}
                className={clsx(
                  "rounded-md border px-2 py-0.5 text-xs outline-none",
                  model.available ? "border-white/10 text-zinc-300" : "border-white/[0.05] text-zinc-600",
                )}
              >
                {model.label}
              </span>
            </Tip>
          ))}
        </div>
      )}

      {children && <div className="space-y-4 border-t border-white/[0.06] p-4">{children}</div>}
    </section>
  );
}
