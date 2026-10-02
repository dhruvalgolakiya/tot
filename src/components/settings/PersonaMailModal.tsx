import { useEffect, useState } from "react";
import { ExternalLink, Paperclip } from "lucide-react";
import type { MailAddress, MailMessage } from "@shared/types";
import { api, errorMessage } from "../../lib/api";
import { formatBytes, toMs } from "../../lib/format";
import { markPersonaMailRead, navigateToConversation } from "../../store";
import { buttonClass } from "../ui/buttonStyles";
import { Callout } from "../ui/Callout";
import { Modal, ModalBody } from "../ui/Modal";
import { Skeleton } from "../ui/Skeleton";
import { CodeChip } from "./CodeChip";

function addressLabel(address: MailAddress): string {
  return address.name ? `${address.name} <${address.address}>` : address.address;
}

type PersonaMailModalProps = {
  personaId: string;
  /** Null keeps the modal mounted (for its close animation) but closed. */
  mailId: string | null;
  onClose: () => void;
  /** The message turned out to be unread and just got marked read; let the row list know. */
  onRead?: (mailId: string) => void;
};

/** A message's full body: headers, codes, links, text, attachments, and a link to the chat it started. */
export function PersonaMailModal({ personaId, mailId, onClose, onRead }: PersonaMailModalProps) {
  const [mail, setMail] = useState<MailMessage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!mailId) return;
    setMail(null);
    setError(null);
    api.getPersonaMail(personaId, mailId).then(
      (message) => {
        setMail(message);
        if (message.unread) {
          markPersonaMailRead(personaId);
          onRead?.(mailId);
        }
      },
      (err: unknown) => setError(errorMessage(err)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onRead is a stable row-list updater, not a dependency
  }, [personaId, mailId]);

  return (
    <Modal open={mailId !== null} onOpenChange={(open) => !open && onClose()} title={mail?.subject || "Message"} className="max-w-2xl">
      <ModalBody className="space-y-4">
        {error && <Callout tone="danger">{error}</Callout>}

        {!mail && !error && (
          <div aria-busy="true" aria-label="Loading message" className="space-y-2">
            <Skeleton className="h-3.5 w-2/3" />
            <Skeleton className="h-3.5 w-1/2" />
            <Skeleton className="h-32 w-full rounded-xl" />
          </div>
        )}

        {mail && (
          <>
            <div className="space-y-1 text-xs text-fg-subtle">
              <p>
                <span className="text-fg-muted">From</span> {addressLabel(mail.from)}
              </p>
              <p>
                <span className="text-fg-muted">To</span> {mail.to.map(addressLabel).join(", ")}
              </p>
              {mail.cc.length > 0 && (
                <p>
                  <span className="text-fg-muted">Cc</span> {mail.cc.map(addressLabel).join(", ")}
                </p>
              )}
              <p>{new Date(toMs(mail.date)).toLocaleString()}</p>
            </div>

            {mail.codes.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {mail.codes.map((code) => (
                  <CodeChip key={code} code={code} />
                ))}
              </div>
            )}

            {mail.links.length > 0 && (
              <div className="space-y-1.5">
                <p className="group-label">Links</p>
                <ul className="space-y-1">
                  {mail.links.map((link, index) => (
                    <li
                      key={`${link.url}-${index}`}
                      className="flex items-center justify-between gap-3 rounded-lg border border-hairline px-3 py-2"
                    >
                      <span className="min-w-0 flex-1 truncate text-sm text-fg">{link.text || link.url}</span>
                      <a href={link.url} target="_blank" rel="noopener noreferrer" className={buttonClass("secondary", "sm")}>
                        <ExternalLink /> Open
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <pre className="max-h-96 overflow-y-auto rounded-xl border border-hairline bg-fill-subtle p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap text-fg">
              {mail.text}
            </pre>

            {mail.attachments.length > 0 && (
              <div className="space-y-1.5">
                <p className="group-label">Attachments</p>
                <ul className="space-y-1">
                  {mail.attachments.map((attachment) => (
                    <li key={attachment.name} className="flex items-center gap-2 text-xs text-fg-subtle">
                      <Paperclip className="size-3.5 shrink-0" />
                      {attachment.name} · {formatBytes(attachment.size)}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {mail.conversationId && (
              <button type="button" onClick={() => navigateToConversation(mail.conversationId!)} className="link text-sm">
                Open chat →
              </button>
            )}
          </>
        )}
      </ModalBody>
    </Modal>
  );
}
