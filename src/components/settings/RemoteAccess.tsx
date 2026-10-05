import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import clsx from "clsx";
import { toast } from "sonner";
import { Check, Copy, Eye, EyeOff, Smartphone } from "lucide-react";
import type { DevicesStatus, RemoteAccessMode, SignInLink } from "@shared/types";
import { api, errorMessage } from "../../lib/api";
import { setDevicesStatus } from "../../lib/remote";
import { useCopy } from "../../hooks/useCopy";
import { notifyError } from "../../store";
import { ConfirmDialog } from "../ConfirmDialog";
import { Button } from "../ui/Button";
import { Callout } from "../ui/Callout";
import { Field } from "../ui/Field";
import { IconButton } from "../ui/IconButton";
import { Modal, ModalBody, ModalFooter } from "../ui/Modal";
import { QrCode } from "../ui/QrCode";
import { RadioCards } from "../ui/RadioCards";
import { Select } from "../ui/Select";
import { Switch } from "../ui/Switch";
import { Tip } from "../ui/Tip";

/**
 * Remote access (roadmap module 07): using TOT from a phone or another computer. This computer never signs
 * in; other devices sign in with the password chosen here, or a phone scans a one-time QR code. Off until
 * the user sets it up: a password, then how other devices reach this one (Tailscale, or this Wi-Fi).
 */

const MODE_LINE: Record<Exclude<RemoteAccessMode, "off">, string> = {
  tailscale: "On · over Tailscale, from anywhere",
  lan: "On · on this Wi‑Fi only",
};

/** The part of the "This device" card about other devices. */
export function RemoteAccessPanel({ status, onSetUp }: { status: DevicesStatus; onSetUp: (step?: SetupStep) => void }) {
  const { access } = status;
  const [turningOff, setTurningOff] = useState(false);
  const [busy, setBusy] = useState(false);
  const { copied, copy } = useCopy();
  const address = access.addresses[0]?.url ?? null;

  async function turnOff() {
    setBusy(true);
    try {
      setDevicesStatus(await api.setRemoteAccess("off"));
    } catch (error) {
      notifyError(error);
    } finally {
      setBusy(false);
    }
  }

  if (access.mode === "off" && !status.signIn) {
    return (
      <div className="flex items-start gap-3">
        <Smartphone className="mt-0.5 size-4 shrink-0 text-fg-muted" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-fg">Use TOT on your phone and other computers</p>
          <p className="mt-0.5 text-xs leading-relaxed text-fg-subtle">
            Choose a password, then scan a code with your phone. This computer never asks for it.
          </p>
        </div>
        <Button size="sm" variant="primary" onClick={() => onSetUp()}>
          Set up
        </Button>
      </div>
    );
  }

  const on = access.mode !== "off";
  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <label htmlFor="remote-access" className="block text-sm font-medium text-fg">
            Remote access
          </label>
          <p className="mt-0.5 text-xs leading-relaxed text-fg-subtle">
            {on ? MODE_LINE[access.mode as Exclude<RemoteAccessMode, "off">] : "Off · only this computer can open TOT. Your password is kept."}
          </p>
        </div>
        <Switch
          id="remote-access"
          checked={on}
          disabled={Boolean(access.setBy) || busy}
          onCheckedChange={(next) => (next ? onSetUp("network") : access.onThisMachine ? void turnOff() : setTurningOff(true))}
        />
      </div>

      {access.setBy && (
        <Callout tone="info">
          Set by <code className="text-2xs">{access.setBy}</code> in .env. Remove it there and restart TOT to manage it here.
        </Callout>
      )}
      {access.problem && <Callout tone="warning">{access.problem}</Callout>}
      {access.envToken && !access.passwordSet && (
        <p className="text-xs leading-relaxed text-fg-subtle">
          Signing in uses <code className="text-2xs">TOT_ACCESS_TOKEN</code> from .env.{" "}
          <button type="button" className="link-muted" onClick={() => onSetUp("password")}>
            Set a password you'll remember
          </button>
          ; the token keeps working for scripts.
        </p>
      )}

      {on && address && (
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-lg bg-fill px-2.5 py-1.5 font-mono text-xs text-fg">{address}</code>
          <Tip content={copied ? "Copied" : "Copy address"}>
            <IconButton label="Copy address" size="sm" onClick={() => void copy(address)}>
              {copied ? <Check /> : <Copy />}
            </IconButton>
          </Tip>
          <Button size="sm" onClick={() => onSetUp("phone")}>
            <Smartphone /> Add a phone
          </Button>
        </div>
      )}

      <ConfirmDialog
        open={turningOff}
        onOpenChange={setTurningOff}
        title="Turn off remote access?"
        description="This browser is on another device, so it loses access too. Turn it back on from this computer itself."
        confirmLabel="Turn off"
        onConfirm={() => void turnOff()}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Set up: a password, how devices reach this one, then the phone
// ---------------------------------------------------------------------------

export type SetupStep = "password" | "network" | "phone";

const STEPS: { id: SetupStep; label: string }[] = [
  { id: "password", label: "Password" },
  { id: "network", label: "Network" },
  { id: "phone", label: "Phone" },
];

/**
 * One dialog for the whole flow, starting where it's needed: no password yet → the password; a password but
 * remote access off → the network; on → just the phone. `afterNetwork` replaces the phone step (e.g. when it
 * was opened to pair a computer).
 */
export function RemoteAccessSetup({
  status,
  open,
  onOpenChange,
  start,
  afterNetwork,
}: {
  status: DevicesStatus;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  start: SetupStep;
  afterNetwork?: { label: string; run: () => void };
}) {
  const [step, setStep] = useState<SetupStep>(start);
  useEffect(() => {
    if (open) setStep(start);
  }, [open, start]);

  function networkDone() {
    if (afterNetwork) {
      onOpenChange(false);
      afterNetwork.run();
    } else {
      setStep("phone");
    }
  }

  const title = step === "password" ? "Choose a password" : step === "network" ? "How should other devices reach this computer?" : "Add your phone";
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={title} className="max-w-md">
      {start !== "phone" && <Steps current={step} skipPassword={start !== "password"} />}
      {step === "password" && (
        <PasswordStep
          intro="You'll type it once on each browser; your phone can scan a code instead. This computer never asks for it."
          status={status}
          submitLabel={status.access.mode === "off" ? "Next" : "Save"}
          onCancel={() => onOpenChange(false)}
          onDone={() => (status.access.mode === "off" ? setStep("network") : onOpenChange(false))}
        />
      )}
      {step === "network" && <NetworkStep status={status} onCancel={() => onOpenChange(false)} onDone={networkDone} doneLabel={afterNetwork?.label} />}
      {step === "phone" && <PhoneStep status={status} open={open && step === "phone"} onDone={() => onOpenChange(false)} />}
    </Modal>
  );
}

function Steps({ current, skipPassword }: { current: SetupStep; skipPassword: boolean }) {
  const shown = skipPassword ? STEPS.slice(1) : STEPS;
  const at = shown.findIndex((step) => step.id === current);
  return (
    <ol className="flex items-center gap-2 px-6 pb-1 text-xs text-fg-subtle" aria-label="Steps">
      {shown.map((step, index) => (
        <li key={step.id} className="flex items-center gap-2" aria-current={index === at ? "step" : undefined}>
          {index > 0 && <span className="h-px w-5 bg-hairline" aria-hidden="true" />}
          <span
            className={clsx(
              "grid size-5 place-items-center rounded-full text-2xs font-medium",
              index < at ? "bg-fg text-canvas" : index === at ? "border border-fg text-fg" : "border border-edge",
            )}
          >
            {index < at ? <Check className="size-3" /> : index + 1}
          </span>
          <span className={index === at ? "text-fg" : undefined}>{step.label}</span>
        </li>
      ))}
    </ol>
  );
}

function PasswordInput({ id, value, onChange, placeholder, autoFocus, autoComplete }: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoFocus?: boolean;
  autoComplete: string;
}) {
  const [shown, setShown] = useState(false);
  return (
    <div className="relative">
      <input
        id={id}
        type={shown ? "text" : "password"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        autoComplete={autoComplete}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        className="input pr-10"
      />
      <button
        type="button"
        onClick={() => setShown(!shown)}
        aria-label={shown ? "Hide password" : "Show password"}
        className="absolute top-1/2 right-1.5 grid size-7 -translate-y-1/2 place-items-center rounded-md text-fg-subtle hover:bg-hover hover:text-fg [&_svg]:size-4"
      >
        {shown ? <EyeOff /> : <Eye />}
      </button>
    </div>
  );
}

/** A new password: on this computer just twice; from another device, the current one first. */
function PasswordStep({
  intro,
  status,
  submitLabel,
  onCancel,
  onDone,
}: {
  intro: ReactNode;
  status: DevicesStatus;
  submitLabel: string;
  onCancel: () => void;
  onDone: () => void;
}) {
  const needsCurrent = status.access.passwordSet && !status.access.onThisMachine;
  const [current, setCurrent] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tooShort = [...password].length < 8;
  const mismatch = again.length > 0 && again !== password;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (tooShort || password !== again || saving) return;
    setSaving(true);
    setError(null);
    try {
      setDevicesStatus(await api.setSignInPassword({ password, ...(needsCurrent ? { current } : {}) }));
      if (status.access.passwordSet) toast.success("Password changed. Other browsers and phones sign in again with it.");
      onDone();
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
      <ModalBody className="space-y-4">
        <p className="text-sm text-fg-muted">{intro}</p>
        {needsCurrent && (
          <Field label="Current password" htmlFor="password-current">
            <PasswordInput id="password-current" value={current} onChange={setCurrent} autoFocus autoComplete="current-password" />
          </Field>
        )}
        <Field label={status.access.passwordSet ? "New password" : "Password"} htmlFor="password-new" hint="8 or more characters.">
          <PasswordInput id="password-new" value={password} onChange={setPassword} autoFocus={!needsCurrent} autoComplete="new-password" />
        </Field>
        <Field label="Type it again" htmlFor="password-again" error={mismatch ? "These don't match yet." : undefined}>
          <PasswordInput id="password-again" value={again} onChange={setAgain} autoComplete="new-password" />
        </Field>
        {status.access.passwordSet && <Callout tone="info">Every other browser and phone will need the new password.</Callout>}
        {status.access.passwordSet && status.access.onThisMachine && (
          <p className="text-xs text-fg-subtle">You're on this computer, so the current password isn't needed.</p>
        )}
        {error && <Callout tone="danger">{error}</Callout>}
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={tooShort || password !== again || (needsCurrent && !current) || saving}>
          {saving ? "Saving…" : submitLabel}
        </Button>
      </ModalFooter>
    </form>
  );
}

function NetworkStep({ status, onCancel, onDone, doneLabel }: { status: DevicesStatus; onCancel: () => void; onDone: () => void; doneLabel?: string }) {
  const tailscale = status.access.tailscaleAddress;
  const [mode, setMode] = useState<"tailscale" | "lan">(status.access.mode === "lan" || (!tailscale && status.access.mode !== "tailscale") ? "lan" : "tailscale");
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function checkAgain() {
    setChecking(true);
    try {
      setDevicesStatus(await api.checkRemoteAccess());
    } catch (err) {
      notifyError(err);
    } finally {
      setChecking(false);
    }
  }

  async function turnOn() {
    setSaving(true);
    setError(null);
    try {
      const next = await api.setRemoteAccess(mode);
      setDevicesStatus(next);
      if (next.access.problem) setError(next.access.problem);
      else onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <ModalBody className="space-y-4">
        <RadioCards
          label="How other devices reach this computer"
          value={mode}
          onValueChange={(next) => {
            setMode(next);
            setError(null);
          }}
          options={[
            {
              value: "tailscale",
              label: (
                <span className="flex items-center gap-2">
                  Anywhere, with Tailscale
                  <span className="rounded-full bg-fill px-1.5 py-0.5 text-2xs font-medium text-fg-muted">Recommended</span>
                </span>
              ),
              description: tailscale ? (
                <>Tailscale is on here ({tailscale}). Your phone needs the Tailscale app, signed in to the same account. Private and encrypted.</>
              ) : (
                <>
                  Tailscale isn't running on this computer. Install it from{" "}
                  <a href="https://tailscale.com/download" target="_blank" rel="noreferrer" className="link-muted" onClick={(event) => event.stopPropagation()}>
                    tailscale.com
                  </a>{" "}
                  and sign in, then{" "}
                  <button
                    type="button"
                    className="link-muted"
                    onClick={(event) => {
                      event.stopPropagation();
                      void checkAgain();
                    }}
                  >
                    {checking ? "checking…" : "check again"}
                  </button>
                  .
                </>
              ),
            },
            {
              value: "lan",
              label: "Only on this Wi‑Fi",
              description: "Your phone must be on the same network. It isn't encrypted, so use it only on networks you trust.",
            },
          ]}
        />
        <p className="text-xs text-fg-subtle">If your Mac asks whether to accept incoming connections, choose Allow.</p>
        {error && <Callout tone="warning">{error}</Callout>}
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" disabled={saving || (mode === "tailscale" && !tailscale)} onClick={() => void turnOn()}>
          {saving ? "Turning on…" : (doneLabel ?? "Turn on")}
        </Button>
      </ModalFooter>
    </>
  );
}

/**
 * The phone scans a QR code: a one-time link to this computer's sign-in page that signs it in. Watches the
 * sign-in list while open and closes once the phone shows up.
 */
function PhoneStep({ status, open, onDone }: { status: DevicesStatus; open: boolean; onDone: () => void }) {
  const offered = status.access.addresses;
  const [address, setAddress] = useState(offered[0]?.url ?? "");
  const [link, setLink] = useState<SignInLink | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const known = useRef(new Set(status.sessions.map((s) => s.id)));
  const done = useRef(onDone);
  done.current = onDone;
  const { copied, copy } = useCopy();
  const network = offered.find((a) => a.url === address)?.network;

  async function makeLink(at = address) {
    setError(null);
    try {
      setLink(await api.signInLink(at || undefined));
    } catch (err) {
      setLink(null);
      setError(errorMessage(err));
    }
  }

  useEffect(() => {
    if (!open) return;
    known.current = new Set(status.sessions.map((s) => s.id));
    void makeLink();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- a fresh code each time it opens
  }, [open]);

  // Watch for the phone signing in.
  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      api.getDevices().then((next) => {
        const joined = next.sessions.find((s) => !known.current.has(s.id));
        if (!joined) return;
        setDevicesStatus(next);
        toast.success(`Signed in: ${joined.label}`);
        done.current();
      }, () => {});
    }, 2000);
    return () => window.clearInterval(timer);
  }, [open]);

  const left = link ? Math.max(0, link.expiresAt - now) : 0;
  const expired = Boolean(link) && left === 0;

  return (
    <>
      <ModalBody className="space-y-4">
        <div className="flex flex-col items-center gap-3 text-center">
          {link && !expired ? (
            <QrCode value={link.url} size={200} label="QR code that signs your phone in to TOT" />
          ) : (
            <div className="grid size-[200px] place-items-center rounded-xl border border-dashed border-edge text-xs text-fg-subtle">
              {expired ? (
                <Button size="sm" onClick={() => void makeLink()}>
                  New code
                </Button>
              ) : (
                (error ?? "Making a code…")
              )}
            </div>
          )}
          <p className="text-sm text-fg-muted">Point your phone's camera at the code. It opens TOT signed in, no password needed.</p>
          <p className="text-xs text-fg-subtle">
            {network === "tailscale"
              ? "Your phone needs the Tailscale app, signed in to the same account."
              : "Your phone needs to be on the same Wi‑Fi."}{" "}
            {link && !expired && `Works once · ${Math.floor(left / 60_000)}:${String(Math.floor((left % 60_000) / 1000)).padStart(2, "0")} left.`}
          </p>
        </div>
        {offered.length > 1 && (
          <Field label="Address" htmlFor="phone-address">
            <Select
              id="phone-address"
              value={address}
              onValueChange={(next) => {
                setAddress(next);
                void makeLink(next);
              }}
              options={offered.map((a) => ({ value: a.url, label: `${a.url}${a.network === "tailscale" ? " (Tailscale)" : a.network === "lan" ? " (Wi‑Fi)" : ""}` }))}
            />
          </Field>
        )}
        {link && !expired && (
          <div className="flex items-center justify-center">
            <button type="button" className="link-muted inline-flex items-center gap-1.5 text-xs" onClick={() => void copy(link.url)}>
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              {copied ? "Copied" : "Copy the link instead"}
            </button>
          </div>
        )}
      </ModalBody>
      <ModalFooter>
        <Button variant="primary" onClick={onDone}>
          Done
        </Button>
      </ModalFooter>
    </>
  );
}

/** Changing the password later (the same step, on its own). */
export function ChangePasswordDialog({ status, open, onOpenChange }: { status: DevicesStatus; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={status.access.passwordSet ? "Change password" : "Set a password"} className="max-w-md">
      {open && (
        <PasswordStep
          intro="Other devices sign in with it. This computer never asks for it."
          status={status}
          submitLabel="Save"
          onCancel={() => onOpenChange(false)}
          onDone={() => onOpenChange(false)}
        />
      )}
    </Modal>
  );
}
