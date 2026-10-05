import { useEffect, useState, type FormEvent } from "react";
import { DropdownMenu } from "radix-ui";
import { Check, Copy, Ellipsis, Laptop, LogOut, Pencil, Smartphone } from "lucide-react";
import type { DevicesStatus, SignInSession } from "@shared/types";
import { api, errorMessage } from "../../lib/api";
import { relativeTime } from "../../lib/format";
import { useCopy } from "../../hooks/useCopy";
import { notifyError } from "../../store";
import { Button } from "../ui/Button";
import { Callout } from "../ui/Callout";
import { cardClass } from "../ui/Card";
import { Field } from "../ui/Field";
import { IconButton } from "../ui/IconButton";
import { Modal, ModalBody, ModalFooter } from "../ui/Modal";
import { SectionHeader } from "../ui/SectionHeader";
import { Skeleton } from "../ui/Skeleton";
import { Tip } from "../ui/Tip";

/**
 * This device and the browsers and phones signed in to it (roadmap module 07). Pairing with
 * other computers comes next (M2); until then this is where you find TOT's address and sign
 * a browser out.
 */
export function DevicesSettings() {
  const [status, setStatus] = useState<DevicesStatus | null>(null);
  const [failed, setFailed] = useState(false);

  async function load() {
    setFailed(false);
    try {
      setStatus(await api.getDevices());
    } catch {
      setFailed(true);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  if (failed) {
    return (
      <Callout
        tone="danger"
        action={
          <button type="button" onClick={() => void load()} className="link-muted">
            Try again
          </button>
        }
      >
        Couldn't load devices.
      </Callout>
    );
  }

  if (!status) {
    return (
      <div className="space-y-8" aria-busy="true" aria-label="Loading devices">
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-28 w-full rounded-xl" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <ThisDevice status={status} onChange={setStatus} />
      <SignedIn status={status} onChange={setStatus} />
    </div>
  );
}

function ThisDevice({ status, onChange }: { status: DevicesStatus; onChange: (status: DevicesStatus) => void }) {
  const { self } = status;
  const [renaming, setRenaming] = useState(false);
  const { copied, copy } = useCopy();

  return (
    <section className="space-y-3">
      <SectionHeader title="This device" />
      <div className={cardClass()}>
        <div className="flex items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-fill text-fg-muted">
            <Laptop className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-fg">{self.name}</p>
            <p className="truncate text-xs text-fg-subtle">
              {self.address ? (self.network === "tailscale" ? "Reachable over Tailscale" : "Reachable on your home network") : "Only this computer can open TOT"}
            </p>
          </div>
          <DropdownMenu.Root modal={false}>
            <DropdownMenu.Trigger asChild>
              <IconButton label="More options for this device" size="sm">
                <Ellipsis />
              </IconButton>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content align="end" sideOffset={4} className="menu w-40">
                <DropdownMenu.Item className="menu-item" onSelect={() => setRenaming(true)}>
                  <Pencil className="size-4" /> Rename
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>

        <div className="mt-4 border-t border-hairline pt-4">
          {self.address ? (
            <div className="space-y-2">
              <p className="text-xs text-fg-subtle">Open TOT on your phone or another computer at</p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-lg bg-fill px-2.5 py-1.5 font-mono text-xs text-fg">{self.address}</code>
                <Tip content={copied ? "Copied" : "Copy address"}>
                  <IconButton label="Copy address" size="sm" onClick={() => void copy(self.address!)}>
                    {copied ? <Check /> : <Copy />}
                  </IconButton>
                </Tip>
              </div>
              <p className="flex items-center gap-1.5 text-xs text-fg-subtle">
                <Smartphone className="size-3.5 shrink-0" />
                On a phone, choose Add to Home Screen to keep TOT as an app.
              </p>
            </div>
          ) : (
            <p className="text-xs leading-relaxed text-fg-subtle">
              To use TOT from your phone or another computer, set{" "}
              <code className="rounded bg-fill px-1 py-0.5 text-2xs text-fg">TOT_ACCESS_TOKEN</code> and{" "}
              <code className="rounded bg-fill px-1 py-0.5 text-2xs text-fg">TOT_LAN=1</code> in{" "}
              <code className="rounded bg-fill px-1 py-0.5 text-2xs text-fg">.env</code>, then restart TOT. With Tailscale on,
              it works from anywhere.
            </p>
          )}
        </div>
      </div>
      <RenameDialog name={self.name} open={renaming} onOpenChange={setRenaming} onRenamed={onChange} />
    </section>
  );
}

function SignedIn({ status, onChange }: { status: DevicesStatus; onChange: (status: DevicesStatus) => void }) {
  const others = status.sessions.filter((session) => !session.current).length;

  async function signOutOthers() {
    try {
      onChange(await api.signOutOtherSessions());
    } catch (error) {
      notifyError(error);
    }
  }

  return (
    <section className="space-y-3">
      <SectionHeader
        title="Signed in"
        description={status.signIn ? "Browsers and phones that can open TOT on this device." : undefined}
        action={
          others > 1 && (
            <button type="button" onClick={() => void signOutOthers()} className="link-muted text-xs">
              Sign out all others
            </button>
          )
        }
      />
      {!status.signIn ? (
        <p className="text-sm text-fg-muted">Sign-in is off, so only this computer can open TOT and nobody needs to sign in.</p>
      ) : (
        <ul className={cardClass({ padding: "none" })}>
          {status.sessions.map((session, index) => (
            <SessionRow key={session.id} session={session} first={index === 0} onChange={onChange} />
          ))}
        </ul>
      )}
    </section>
  );
}

function SessionRow({ session, first, onChange }: { session: SignInSession; first: boolean; onChange: (status: DevicesStatus) => void }) {
  const [busy, setBusy] = useState(false);
  const phone = /iPhone|iPad|Android/.test(session.label);

  async function signOut() {
    setBusy(true);
    try {
      onChange(await api.signOutSession(session.id));
    } catch (error) {
      notifyError(error);
      setBusy(false);
    }
  }

  return (
    <li className={`group flex min-h-14 items-center gap-3 px-4 py-2.5 ${first ? "" : "border-t border-hairline"}`}>
      {phone ? <Smartphone className="size-4 shrink-0 text-fg-subtle" /> : <Laptop className="size-4 shrink-0 text-fg-subtle" />}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-fg">{session.label}</p>
        <p className="truncate text-xs text-fg-subtle">{session.current ? "This browser" : `Active ${relativeTime(session.lastSeenAt)}`}</p>
      </div>
      {!session.current && (
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => void signOut()}
          className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
        >
          <LogOut /> {busy ? "Signing out…" : "Sign out"}
        </Button>
      )}
    </li>
  );
}

function RenameDialog({
  name,
  open,
  onOpenChange,
  onRenamed,
}: {
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRenamed: (status: DevicesStatus) => void;
}) {
  const [value, setValue] = useState(name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setValue(name);
    setSaving(false);
    setError(null);
  }, [open, name]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      onRenamed(await api.renameDevice(value));
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Rename this device" className="max-w-md">
      <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
        <ModalBody className="space-y-4">
          <Field label="Name" htmlFor="device-name" hint="Shown on your other devices once they're paired. Leave it empty to use the computer's own name.">
            <input
              id="device-name"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              maxLength={40}
              autoFocus
              autoComplete="off"
              className="input"
            />
          </Field>
          {error && <Callout tone="danger">{error}</Callout>}
        </ModalBody>
        <ModalFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={saving || value.trim() === name}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}
