import { useState, type FormEvent, type ReactNode } from "react";
import clsx from "clsx";
import { ChevronDown } from "lucide-react";
import type { MailboxConnectRequest, Persona } from "@shared/types";
import { api, errorMessage } from "../../lib/api";
import { isGmailAddress } from "../../lib/personas";
import { setPersona } from "../../store";
import { Button } from "../ui/Button";
import { Callout } from "../ui/Callout";
import { Field } from "../ui/Field";
import { LedgerField, LedgerGroup } from "../ui/Ledger";

function StepBadge({ children }: { children: ReactNode }) {
  return (
    <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-fill text-2xs font-medium text-fg-muted">
      {children}
    </span>
  );
}

/** Not connected (or a previous attempt failed): the app-password form, with Gmail steps when the address is a Gmail one. */
export function PersonaMailboxConnect({ persona }: { persona: Persona }) {
  const gmail = isGmailAddress(persona.email);
  const [password, setPasswordValue] = useState("");
  const [username, setUsername] = useState("");
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState("");
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(!gmail);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A host without its port (or vice versa) is an incomplete override — block submit rather than guess.
  const imapHalfFilled = Boolean(imapHost.trim()) !== Boolean(imapPort.trim());
  const smtpHalfFilled = Boolean(smtpHost.trim()) !== Boolean(smtpPort.trim());
  const canSubmit = password.length > 0 && !imapHalfFilled && !smtpHalfFilled && !busy;

  async function connect(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    const body: MailboxConnectRequest = {
      password,
      ...(username.trim() ? { username: username.trim() } : {}),
      ...(imapHost.trim() && imapPort.trim() ? { imap: { host: imapHost.trim(), port: Number(imapPort) } } : {}),
      ...(smtpHost.trim() && smtpPort.trim() ? { smtp: { host: smtpHost.trim(), port: Number(smtpPort) } } : {}),
    };
    try {
      setPersona(await api.connectPersonaMailbox(persona.id, body));
      // Never echo the password back — clear the form on success.
      setPasswordValue("");
      setUsername("");
      setImapHost("");
      setImapPort("");
      setSmtpHost("");
      setSmtpPort("");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <LedgerGroup title={`Connect ${persona.name}'s mailbox`}>
      <form onSubmit={(event) => void connect(event)}>
        <LedgerField
          stacked
          title="App password"
          htmlFor="persona-mailbox-password"
          control={
            <div className="space-y-3">
              {gmail && (
                <ol className="space-y-3">
                  <li className="flex gap-3">
                    <StepBadge>1</StepBadge>
                    <p className="flex-1 text-sm text-fg-muted">
                      Turn on{" "}
                      <a href="https://myaccount.google.com/signinoptions/twosv" target="_blank" rel="noopener noreferrer" className="link">
                        2-Step Verification
                      </a>{" "}
                      on {persona.email}.
                    </p>
                  </li>
                  <li className="flex gap-3">
                    <StepBadge>2</StepBadge>
                    <p className="flex-1 text-sm text-fg-muted">
                      Create an{" "}
                      <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener noreferrer" className="link">
                        app password
                      </a>{" "}
                      for it.
                    </p>
                  </li>
                  <li className="flex gap-3">
                    <StepBadge>3</StepBadge>
                    <p className="flex-1 text-sm text-fg-muted">Paste it below.</p>
                  </li>
                </ol>
              )}

              <input
                id="persona-mailbox-password"
                type="password"
                value={password}
                onChange={(event) => {
                  setPasswordValue(event.target.value);
                  setError(null);
                }}
                autoComplete="off"
                placeholder="•••• •••• •••• ••••"
                className="input w-full rounded-xl font-mono"
              />

              <div>
                <button
                  type="button"
                  onClick={() => setAdvancedOpen((value) => !value)}
                  className="link-muted flex items-center gap-1 text-xs"
                >
                  <ChevronDown className={clsx("size-3.5 transition-transform", advancedOpen && "rotate-180")} />
                  Advanced
                </button>
                {advancedOpen && (
                  <div className="mt-2.5 space-y-3 border-t border-hairline pt-3">
                    <Field label="Username" htmlFor="persona-mailbox-username" hint="Only if it isn't the email address above.">
                      <input
                        id="persona-mailbox-username"
                        value={username}
                        onChange={(event) => setUsername(event.target.value)}
                        autoComplete="off"
                        spellCheck={false}
                        className="input h-9 rounded-lg"
                      />
                    </Field>
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="IMAP host" htmlFor="persona-imap-host">
                        <input
                          id="persona-imap-host"
                          value={imapHost}
                          onChange={(event) => setImapHost(event.target.value)}
                          placeholder="imap.example.com"
                          autoComplete="off"
                          spellCheck={false}
                          className="input h-9 rounded-lg font-mono"
                        />
                      </Field>
                      <Field label="IMAP port" htmlFor="persona-imap-port">
                        <input
                          id="persona-imap-port"
                          value={imapPort}
                          onChange={(event) => setImapPort(event.target.value.replace(/\D/g, ""))}
                          inputMode="numeric"
                          placeholder="993"
                          autoComplete="off"
                          className="input h-9 rounded-lg font-mono"
                        />
                      </Field>
                      <Field label="SMTP host" htmlFor="persona-smtp-host">
                        <input
                          id="persona-smtp-host"
                          value={smtpHost}
                          onChange={(event) => setSmtpHost(event.target.value)}
                          placeholder="smtp.example.com"
                          autoComplete="off"
                          spellCheck={false}
                          className="input h-9 rounded-lg font-mono"
                        />
                      </Field>
                      <Field label="SMTP port" htmlFor="persona-smtp-port">
                        <input
                          id="persona-smtp-port"
                          value={smtpPort}
                          onChange={(event) => setSmtpPort(event.target.value.replace(/\D/g, ""))}
                          inputMode="numeric"
                          placeholder="465"
                          autoComplete="off"
                          className="input h-9 rounded-lg font-mono"
                        />
                      </Field>
                    </div>
                  </div>
                )}
              </div>

              {error && <Callout tone="danger">{error}</Callout>}

              <Button type="submit" variant="primary" size="sm" disabled={!canSubmit}>
                {busy ? "Connecting…" : "Connect"}
              </Button>
            </div>
          }
        />
      </form>
    </LedgerGroup>
  );
}
