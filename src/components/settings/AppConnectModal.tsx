import { useState } from "react";
import { Check, Copy, ExternalLink, LoaderCircle } from "lucide-react";
import type { AppKeyField } from "@shared/types";
import type { ConnectFlowState } from "../../hooks/useAppConnect";
import { useCopy } from "../../hooks/useCopy";
import { Button } from "../ui/Button";
import { buttonClass } from "../ui/buttonStyles";
import { Callout } from "../ui/Callout";
import { Field } from "../ui/Field";
import { IconButton } from "../ui/IconButton";
import { Modal } from "../ui/Modal";
import { SecretInput } from "../ui/SecretInput";
import { Tip } from "../ui/Tip";

type AppConnectModalProps = {
  flow: ConnectFlowState | null;
  onCancel: () => void;
  onRetry: () => void;
  onSubmitKey: (values: Record<string, string>) => Promise<string | null>;
  onSubmitClient: (clientId: string, clientSecret: string) => Promise<string | null>;
};

/** "Connect {name}": the sign-in pop-up + poll, an API key form, or guided OAuth-client setup. */
export function AppConnectModal({ flow, onCancel, onRetry, onSubmitKey, onSubmitClient }: AppConnectModalProps) {
  return (
    <Modal open={flow !== null} onOpenChange={(open) => !open && onCancel()} title={flow ? `Connect ${flow.name}` : ""} className="max-w-md">
      {flow && (
        <div className="px-5 pb-5">
          {flow.kind === "loading" && <LoadingStep />}
          {flow.kind === "sign-in-remote" && <RemoteStep name={flow.name} onClose={onCancel} />}
          {flow.kind === "waiting" && <WaitingStep fallbackUrl={flow.fallbackUrl} onCancel={onCancel} />}
          {flow.kind === "key" && (
            <KeyStep key={flow.appId} fields={flow.fields} help={flow.help} onCancel={onCancel} onSubmit={onSubmitKey} />
          )}
          {flow.kind === "client" && (
            <ClientStep
              key={flow.appId}
              provider={flow.provider}
              redirectUri={flow.redirectUri}
              consoleUrl={flow.consoleUrl}
              onCancel={onCancel}
              onSubmit={onSubmitClient}
            />
          )}
          {flow.kind === "error" && <ErrorStep message={flow.message} onCancel={onCancel} onRetry={onRetry} />}
        </div>
      )}
    </Modal>
  );
}

function LoadingStep() {
  return (
    <div className="flex items-center gap-2 py-2 text-sm text-fg-muted">
      <LoaderCircle className="size-4 animate-spin text-accent" />
      Connecting…
    </div>
  );
}

function RemoteStep({ name, onClose }: { name: string; onClose: () => void }) {
  return (
    <div className="space-y-3">
      <p className="text-sm leading-relaxed text-fg-muted">
        Signing in finishes on the Mac that runs TOT. Open TOT there to connect {name}; once connected it works on every device.
      </p>
      <Button variant="secondary" size="sm" onClick={onClose}>
        Close
      </Button>
    </div>
  );
}

function WaitingStep({ fallbackUrl, onCancel }: { fallbackUrl: string | null; onCancel: () => void }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm text-fg-muted">
        <LoaderCircle className="size-4 animate-spin text-accent" />
        Waiting for you to approve in the pop-up…
      </div>
      {fallbackUrl && (
        <a href={fallbackUrl} target="_blank" rel="noopener noreferrer" className={buttonClass("secondary", "sm")}>
          <ExternalLink /> Open sign-in page
        </a>
      )}
      <Button variant="ghost" size="sm" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

function ErrorStep({ message, onCancel, onRetry }: { message: string; onCancel: () => void; onRetry: () => void }) {
  return (
    <div className="space-y-3">
      <Callout tone="danger">{message}</Callout>
      <div className="flex items-center gap-2">
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Try again
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

type KeyStepProps = {
  fields: AppKeyField[];
  help: { label: string; url: string } | null;
  onCancel: () => void;
  onSubmit: (values: Record<string, string>) => Promise<string | null>;
};

function KeyStep({ fields, help, onCancel, onSubmit }: KeyStepProps) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.name, ""])));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const canSubmit = fields.every((f) => (values[f.name] ?? "").trim());

  async function submit() {
    setSubmitting(true);
    setError(null);
    const message = await onSubmit(values);
    if (message) setError(message);
    setSubmitting(false);
  }

  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSubmit && !submitting) void submit();
      }}
    >
      {fields.map((field) => (
        <Field key={field.name} label={field.label} htmlFor={`app-key-${field.name}`} hint={field.prefix ? `Sent as “${field.prefix}…”` : undefined}>
          <SecretInput
            id={`app-key-${field.name}`}
            value={values[field.name] ?? ""}
            onChange={(value) => {
              setValues((current) => ({ ...current, [field.name]: value }));
              setError(null);
            }}
            saved={false}
            cleared={false}
            onClearedChange={() => {}}
            placeholder="Paste it here"
          />
        </Field>
      ))}
      {help && (
        <a href={help.url} target="_blank" rel="noopener noreferrer" className="link inline-block text-xs">
          {help.label}
        </a>
      )}
      {error && <Callout tone="danger">{error}</Callout>}
      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" size="sm" disabled={!canSubmit || submitting}>
          {submitting ? "Connecting…" : "Connect"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

type ClientStepProps = {
  provider: string;
  redirectUri: string;
  consoleUrl: string | null;
  onCancel: () => void;
  onSubmit: (clientId: string, clientSecret: string) => Promise<string | null>;
};

function ClientStep({ provider, redirectUri, consoleUrl, onCancel, onSubmit }: ClientStepProps) {
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const { copied, copy } = useCopy();
  const isGoogle = provider.toLowerCase().includes("google");

  async function submit() {
    setSubmitting(true);
    setError(null);
    const message = await onSubmit(clientId.trim(), clientSecret.trim());
    if (message) setError(message);
    setSubmitting(false);
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (clientId.trim() && clientSecret.trim() && !submitting) void submit();
      }}
    >
      <ol className="space-y-3.5 text-sm text-fg-muted">
        <li className="flex gap-2.5">
          <span className="text-fg-subtle">1.</span>
          <span className="min-w-0 flex-1">
            Create an OAuth app in {provider}&rsquo;s console
            {consoleUrl && (
              <>
                {" — "}
                <a href={consoleUrl} target="_blank" rel="noopener noreferrer" className="link">
                  open console
                </a>
              </>
            )}
            {isGoogle && (
              <span className="mt-1 block text-xs leading-relaxed text-fg-subtle">
                Create a “Web application” OAuth client, enable the API (e.g. Gmail API), and publish the consent screen (“In
                production”) so sign-ins don&rsquo;t expire weekly. This client is reused for other Google apps.
              </span>
            )}
          </span>
        </li>
        <li className="flex gap-2.5">
          <span className="text-fg-subtle">2.</span>
          <span className="min-w-0 flex-1">
            Add this redirect URL
            <div className="mt-1.5 flex items-center gap-1.5">
              <code className="min-w-0 flex-1 truncate rounded-lg border border-edge bg-fill-subtle px-2.5 py-1.5 text-xs text-fg-muted">
                {redirectUri}
              </code>
              <Tip content={copied ? "Copied" : "Copy"}>
                <IconButton label="Copy redirect URL" size="sm" onClick={() => void copy(redirectUri)}>
                  {copied ? <Check /> : <Copy />}
                </IconButton>
              </Tip>
            </div>
          </span>
        </li>
        <li className="flex gap-2.5">
          <span className="text-fg-subtle">3.</span>
          <span className="min-w-0 flex-1 space-y-3">
            <Field label="Client ID" htmlFor="app-client-id">
              <input
                id="app-client-id"
                value={clientId}
                onChange={(event) => {
                  setClientId(event.target.value);
                  setError(null);
                }}
                autoComplete="off"
                spellCheck={false}
                className="input font-mono"
              />
            </Field>
            <Field label="Client secret" htmlFor="app-client-secret">
              <SecretInput
                id="app-client-secret"
                value={clientSecret}
                onChange={(value) => {
                  setClientSecret(value);
                  setError(null);
                }}
                saved={false}
                cleared={false}
                onClearedChange={() => {}}
                placeholder="Paste it here"
              />
            </Field>
          </span>
        </li>
      </ol>
      {error && <Callout tone="danger">{error}</Callout>}
      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" size="sm" disabled={!clientId.trim() || !clientSecret.trim() || submitting}>
          {submitting ? "Saving…" : "Save & continue"}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
