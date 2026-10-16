import clsx from "clsx";
import type { MailSummary } from "@tot/shared/types";
import { relativeTime } from "../../lib/format";
import { Badge } from "../ui/Badge";
import { ledgerRowClass } from "../ui/Ledger";
import { CodeChip } from "./CodeChip";

type PersonaMailRowProps = {
  mail: MailSummary;
  onOpen: () => void;
};

/** One message in a persona's inbox: sender, subject, snippet, time, and any codes found in it. */
export function PersonaMailRow({ mail, onOpen }: PersonaMailRowProps) {
  const sender = mail.from.name || mail.from.address;

  return (
    <button type="button" onClick={onOpen} className={ledgerRowClass({ interactive: true, className: "items-start gap-3 py-2" })}>
      <span className="mt-1.5 flex size-5 shrink-0 items-center justify-center">
        {mail.unread && <span aria-hidden="true" className="size-2 rounded-full bg-accent" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <p className={clsx("min-w-0 flex-1 truncate text-ui", mail.unread ? "font-semibold text-fg" : "text-fg")}>{sender}</p>
          {mail.outgoing && <Badge>Sent</Badge>}
          <span className="shrink-0 text-xs text-fg-subtle tabular-nums">{relativeTime(mail.date)}</span>
        </div>
        <p className={clsx("truncate text-xs", mail.unread ? "font-medium text-fg" : "text-fg-muted")}>{mail.subject || "(no subject)"}</p>
        <p className="truncate text-xs text-fg-subtle">{mail.snippet}</p>
        {mail.codes.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {mail.codes.map((code) => (
              <CodeChip key={code} code={code} />
            ))}
          </div>
        )}
      </div>
    </button>
  );
}
