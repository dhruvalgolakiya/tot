import { useEffect, useState, type FormEvent } from "react";
import clsx from "clsx";
import { DropdownMenu } from "radix-ui";
import { toast } from "sonner";
import { Check, Copy, Ellipsis, KeyRound, Laptop, Link2, LogOut, Pencil, RefreshCw, Smartphone, Unlink, Wifi } from "lucide-react";
import type { Device, DevicesStatus, SignInSession } from "@shared/types";
import { api, errorMessage } from "../../lib/api";
import { relativeTime } from "../../lib/format";
import { setDevicesStatus, useDevices } from "../../lib/remote";
import { useCopy } from "../../hooks/useCopy";
import { notifyError } from "../../store";
import { ConfirmDialog } from "../ConfirmDialog";
import { ChangePasswordDialog, RemoteAccessPanel, RemoteAccessSetup, type SetupStep } from "./RemoteAccess";
import { Button } from "../ui/Button";
import { Callout } from "../ui/Callout";
import { EmptyState } from "../ui/EmptyState";
import { Field } from "../ui/Field";
import { IconButton } from "../ui/IconButton";
import { LedgerField, LedgerGroup, ledgerRowClass } from "../ui/Ledger";
import { Modal, ModalBody, ModalFooter } from "../ui/Modal";
import { Skeleton } from "../ui/Skeleton";
import { StatusDot } from "../ui/StatusDot";
import { Tip } from "../ui/Tip";

/**
 * This device, the devices paired with it, and the browsers and phones signed in to it (roadmap
 * module 07): TOT's address here, pairing, and signing a browser out.
 */
export function DevicesSettings() {
  const status = useDevices((s) => s.status);
  const [failed, setFailed] = useState(false);

  async function load() {
    setFailed(false);
    try {
      setDevicesStatus(await api.getDevices());
    } catch {
      setFailed(true);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  if (failed && !status) {
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
        <Skeleton className="h-24 w-full rounded-2xl" />
        <Skeleton className="h-28 w-full rounded-2xl" />
      </div>
    );
  }

  return (
    <DevicesPage status={status} />
  );
}

/** The page itself, with the remote-access setup that several sections open. */
function DevicesPage({ status }: { status: DevicesStatus }) {
  const [setup, setSetup] = useState<{ open: boolean; start: SetupStep; pairAfter: boolean }>({ open: false, start: "password", pairAfter: false });
  const [pairing, setPairing] = useState(false);

  /** Starts where it's needed: no password yet, then the network, then a phone. */
  function openSetup(step?: SetupStep, pairAfter = false) {
    const start = step ?? (!status.signIn ? "password" : status.access.mode === "off" ? "network" : "phone");
    setSetup({ open: true, start, pairAfter });
  }

  return (
    <div className="space-y-8">
      <ThisDevice status={status} onChange={setDevicesStatus} onSetUp={openSetup} />
      <PairedDevices
        status={status}
        pairing={pairing}
        onPairingChange={setPairing}
        // Pairing needs sign-in on both computers: set it up here first, then pair.
        onPair={() => (status.signIn ? setPairing(true) : openSetup("password", true))}
      />
      {status.signIn && <SignedIn status={status} onChange={setDevicesStatus} onAddPhone={() => openSetup("phone")} />}
      <RemoteAccessSetup
        status={status}
        open={setup.open}
        onOpenChange={(open) => setSetup((current) => ({ ...current, open }))}
        start={setup.start}
        afterNetwork={setup.pairAfter ? { label: "Turn on and pair", run: () => setPairing(true) } : undefined}
      />
    </div>
  );
}

function ThisDevice({
  status,
  onChange,
  onSetUp,
}: {
  status: DevicesStatus;
  onChange: (status: DevicesStatus) => void;
  onSetUp: (step?: SetupStep) => void;
}) {
  const { self, access } = status;
  const [renaming, setRenaming] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);

  return (
    <LedgerGroup title="This device">
      <LedgerField
        title={
          <span className="flex items-center gap-2">
            <Laptop className="size-4 text-fg-muted" />
            {self.name}
          </span>
        }
        description={
          !self.address
            ? "Only this computer can open TOT"
            : self.network === "tailscale"
              ? "Reachable over Tailscale, from anywhere"
              : self.network === "lan"
                ? "Reachable on this Wi‑Fi"
                : "Reachable at its address"
        }
        control={
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
                {status.signIn && (
                  <DropdownMenu.Item className="menu-item" onSelect={() => setChangingPassword(true)}>
                    <KeyRound className="size-4" /> {access.passwordSet ? "Change password" : "Set a password"}
                  </DropdownMenu.Item>
                )}
                {access.mode !== "off" && !access.setBy && (
                  <DropdownMenu.Item className="menu-item" onSelect={() => onSetUp("network")}>
                    <Wifi className="size-4" /> Change network
                  </DropdownMenu.Item>
                )}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        }
      />
      <RemoteAccessPanel status={status} onSetUp={onSetUp} />
      <RenameDialog name={self.name} open={renaming} onOpenChange={setRenaming} onRenamed={onChange} />
      <ChangePasswordDialog status={status} open={changingPassword} onOpenChange={setChangingPassword} />
    </LedgerGroup>
  );
}

/** Other computers running TOT: their agents show in the rail here, and this device's agents there. */
function PairedDevices({
  status,
  pairing,
  onPairingChange,
  onPair,
}: {
  status: DevicesStatus;
  pairing: boolean;
  onPairingChange: (open: boolean) => void;
  onPair: () => void;
}) {
  const warnings = status.devices.flatMap((device) => device.warnings);

  return (
    <div className="space-y-3">
      <LedgerGroup
        body="rows"
        title="Paired devices"
        count={status.devices.length}
        description="Use their agents from here, and this device's agents from there."
        action={
          <Button size="sm" onClick={onPair}>
            <Link2 /> Pair a device
          </Button>
        }
      >
        {status.devices.length === 0 ? (
          <EmptyState
            variant="quiet"
            icon={<Link2 />}
            title="No paired devices yet"
            description="Install TOT on your other computer, then pair them here: one link, pasted once, works both ways."
          />
        ) : (
          status.devices.map((device) => <PairedRow key={device.id} device={device} />)
        )}
      </LedgerGroup>
      {warnings.map((warning) => (
        <Callout key={warning} tone="warning">
          {warning}
        </Callout>
      ))}
      <PairDialog status={status} open={pairing} onOpenChange={onPairingChange} />
    </div>
  );
}

function deviceLine(device: Device): string {
  if (device.problem) return device.problem;
  if (device.online) return device.canReachUs ? "Online" : `Online · it can't reach this device`;
  return `Offline${device.lastSeenAt ? ` · seen ${relativeTime(device.lastSeenAt)}` : ""}`;
}

function PairedRow({ device }: { device: Device }) {
  const [moving, setMoving] = useState(false);
  const [unpairing, setUnpairing] = useState(false);

  async function act(run: () => Promise<DevicesStatus>) {
    try {
      setDevicesStatus(await run());
    } catch (error) {
      notifyError(error);
    }
  }

  return (
    <div className={ledgerRowClass()}>
      <span className="relative grid size-5 shrink-0 place-items-center">
        <Laptop className="size-4 text-fg-subtle" />
        <span className="absolute -right-1 -bottom-0.5">
          <StatusDot tone={device.online ? "green" : "gray"} />
        </span>
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-ui text-fg">{device.name}</p>
        <p className={clsx("truncate text-xs", device.problem ? "text-danger" : "text-fg-subtle")}>{deviceLine(device)}</p>
      </div>
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger asChild>
          <IconButton label={`More options for ${device.name}`} size="sm">
            <Ellipsis />
          </IconButton>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={4} className="menu w-48">
            {!device.online && device.address && (
              <DropdownMenu.Item className="menu-item" onSelect={() => void act(() => api.updateDevice(device.id, {}))}>
                <RefreshCw className="size-4" /> Try again
              </DropdownMenu.Item>
            )}
            <DropdownMenu.Item className="menu-item" onSelect={() => setMoving(true)}>
              <Pencil className="size-4" /> Change address
            </DropdownMenu.Item>
            <DropdownMenu.Item className="menu-item menu-item-danger" onSelect={() => setUnpairing(true)}>
              <Unlink className="size-4" /> Unpair
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <AddressDialog device={device} open={moving} onOpenChange={setMoving} />
      <ConfirmDialog
        open={unpairing}
        onOpenChange={setUnpairing}
        title={`Unpair ${device.name}?`}
        description={`Its agents leave this device's rail, and this device's agents leave its rail. Nothing is deleted: every chat stays on the device it's on.`}
        confirmLabel="Unpair"
        onConfirm={() => void act(() => api.unpairDevice(device.id))}
      />
    </div>
  );
}

/**
 * One dialog for both directions: this device's link to paste over there, or the other device's link
 * pasted here. Either way one paste pairs them both ways. Closes on its own when the other side
 * pastes this device's link (a `device` event adds it to the list).
 */
function PairDialog({ status, open, onOpenChange }: { status: DevicesStatus; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [link, setLink] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [known] = useState(() => new Set(status.devices.map((d) => d.id)));
  const { copied, copy } = useCopy();

  useEffect(() => {
    if (!open) return;
    setPasted("");
    setError(null);
    setLink(null);
    setLinkError(null);
    for (const device of status.devices) known.add(device.id);
    api
      .pairingLink()
      .then((made) => setLink(made.link))
      .catch((err) => setLinkError(errorMessage(err)));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when it opens: a new link replaces the last one
  }, [open]);

  // The other device pasted our link.
  const joined = status.devices.find((device) => !known.has(device.id));
  useEffect(() => {
    if (!open || !joined) return;
    known.add(joined.id);
    toast.success(`Paired with ${joined.name}. Its agents are in your rail.`);
    onOpenChange(false);
  }, [open, joined, known, onOpenChange]);

  async function connect(event: FormEvent) {
    event.preventDefault();
    if (!pasted.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.connectDevice(pasted.trim());
      known.add(result.deviceId);
      setDevicesStatus(result);
      const name = result.devices.find((d) => d.id === result.deviceId)?.name ?? "the other device";
      if (result.canReachYou) toast.success(`Paired with ${name}. Its agents are in your rail.`);
      else {
        toast.warning(`Paired with ${name}, one way: you can use ${name} from here, but it can't reach this device. Turn on Tailscale on both to fix it.`, {
          duration: 10_000,
        });
      }
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Pair a device" className="max-w-md">
      <form onSubmit={connect} className="flex min-h-0 flex-1 flex-col">
        <ModalBody className="space-y-5">
          <div className="space-y-2">
            <p className="text-sm text-fg-muted">
              On the other device, open <strong className="font-medium text-fg">Settings → Devices → Pair a device</strong> and paste
              this link:
            </p>
            {linkError ? (
              <p className="text-xs leading-relaxed text-fg-subtle">{linkError}</p>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded-lg bg-fill px-2.5 py-1.5 font-mono text-xs text-fg">{link ?? "Making a link…"}</code>
                  <Tip content={copied ? "Copied" : "Copy link"}>
                    <IconButton label="Copy link" size="sm" disabled={!link} onClick={() => link && void copy(link)}>
                      {copied ? <Check /> : <Copy />}
                    </IconButton>
                  </Tip>
                </div>
                <p className="text-xs text-fg-subtle">Works once, for 5 minutes. This dialog closes when they're paired.</p>
              </>
            )}
          </div>

          <div className="flex items-center gap-3 text-xs text-fg-subtle">
            <span className="h-px flex-1 bg-hairline" />
            or
            <span className="h-px flex-1 bg-hairline" />
          </div>

          <Field label="Paste the link from the other device" htmlFor="pair-link">
            <input
              id="pair-link"
              value={pasted}
              onChange={(event) => {
                setPasted(event.target.value);
                setError(null);
              }}
              placeholder="http://100.101.4.2:5173/pair#K7QM-4RXP-2HWD"
              autoComplete="off"
              spellCheck={false}
              className="input font-mono text-xs"
            />
          </Field>
          {error && <Callout tone="danger">{error}</Callout>}
        </ModalBody>
        <ModalFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={!pasted.trim() || busy}>
            {busy ? "Pairing…" : "Pair"}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

function AddressDialog({ device, open, onOpenChange }: { device: Device; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [value, setValue] = useState(device.address ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setValue(device.address ?? "");
    setSaving(false);
    setError(null);
  }, [open, device.address]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      setDevicesStatus(await api.updateDevice(device.id, { address: value.trim() }));
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange} title={`Where to reach ${device.name}`} className="max-w-md">
      <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
        <ModalBody className="space-y-4">
          <Field label="Address" htmlFor="device-address" hint={`The address its Settings → Devices page shows. TOT checks it's ${device.name} before saving.`}>
            <input
              id="device-address"
              value={value}
              onChange={(event) => setValue(event.target.value)}
              placeholder="http://100.101.4.2:5173"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              className="input font-mono text-xs"
            />
          </Field>
          {error && <Callout tone="danger">{error}</Callout>}
        </ModalBody>
        <ModalFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={saving || !value.trim() || value.trim() === device.address}>
            {saving ? "Checking…" : "Save"}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

function SignedIn({ status, onChange, onAddPhone }: { status: DevicesStatus; onChange: (status: DevicesStatus) => void; onAddPhone: () => void }) {
  const others = status.sessions.filter((session) => !session.current).length;

  async function signOutOthers() {
    try {
      onChange(await api.signOutOtherSessions());
    } catch (error) {
      notifyError(error);
    }
  }

  return (
    <LedgerGroup
      body="rows"
      title="Signed in"
      count={status.sessions.length}
      description="Phones and browsers on other devices. This computer never needs to sign in."
      action={
        others > 1 && (
          <button type="button" onClick={() => void signOutOthers()} className="link-muted text-xs">
            Sign out all others
          </button>
        )
      }
    >
      {status.sessions.length === 0 ? (
        <EmptyState
          variant="quiet"
          title="No other devices signed in yet"
          action={
            status.access.mode !== "off" && (
              <button type="button" className="link-muted" onClick={onAddPhone}>
                Add a phone
              </button>
            )
          }
        />
      ) : (
        status.sessions.map((session) => <SessionRow key={session.id} session={session} onChange={onChange} />)
      )}
    </LedgerGroup>
  );
}

function SessionRow({ session, onChange }: { session: SignInSession; onChange: (status: DevicesStatus) => void }) {
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
    <div className={clsx("group", ledgerRowClass())}>
      <span className="grid size-5 shrink-0 place-items-center text-fg-subtle">
        {phone ? <Smartphone className="size-4" /> : <Laptop className="size-4" />}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-ui text-fg">{session.label}</p>
        <p className="truncate text-xs text-fg-subtle">{session.current ? "This browser" : `Active ${relativeTime(session.lastSeenAt)}`}</p>
      </div>
      {session.current ? (
        // This browser, on another device: signing out goes to the sign-in page.
        <form method="post" action="/logout">
          <Button type="submit" variant="ghost" size="sm">
            <LogOut /> Sign out
          </Button>
        </form>
      ) : (
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
    </div>
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
