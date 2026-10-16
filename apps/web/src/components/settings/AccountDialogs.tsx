import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Copy, FolderOpen, LoaderCircle } from "lucide-react";
import type { AccountStatus, ProviderAccount, ProviderId, T3ImportCandidate } from "@tot/shared/types";
import { api, errorMessage } from "../../lib/api";
import { copyText } from "../../lib/clipboard";
import { totDesktop } from "../../lib/desktop";
import { PROVIDER_LABELS } from "../../lib/models";
import { tildePath } from "../../lib/projects";
import { notifyError } from "../../store";
import { Button } from "../ui/Button";
import { Callout } from "../ui/Callout";
import { Field } from "../ui/Field";
import { Modal, ModalBody, ModalFooter } from "../ui/Modal";
import { RadioCards } from "../ui/RadioCards";
import { Skeleton } from "../ui/Skeleton";
import { Switch } from "../ui/Switch";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** Add an account by hand: which provider, a name, and its config folder. */
export function AddAccountDialog({ open, onOpenChange, onAdded }: { open: boolean; onOpenChange: (open: boolean) => void; onAdded: (account: ProviderAccount) => void }) {
  const [driver, setDriver] = useState<ProviderId>("claude");
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [tools, setTools] = useState(true);
  const [saving, setSaving] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // macOS's folder picker: a sheet in the Mac app, else opened by the server for a browser on this Mac.
  const canPick = Boolean(totDesktop?.pickFolder) || LOOPBACK_HOSTS.has(window.location.hostname);

  useEffect(() => {
    if (!open) return;
    setDriver("claude");
    setName("");
    setFolder("");
    setTools(true);
    setError(null);
  }, [open]);

  async function pick() {
    setPicking(true);
    try {
      const path = totDesktop?.pickFolder ? await totDesktop.pickFolder() : (await api.pickAccountFolder()).path;
      if (path) setFolder(tildePath(path));
    } catch (err) {
      notifyError(err);
    } finally {
      setPicking(false);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const account = await api.addAccount({ driver, name, configDir: folder, useAccountTools: tools });
      onAdded(account);
      onOpenChange(false);
      toast.success("Account added");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const example = driver === "claude" ? "~/.claude-work" : "~/.codex-work";
  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Add account" description="Another sign-in, kept in its own config folder." className="max-w-md">
      <form onSubmit={(event) => void submit(event)} className="flex min-h-0 flex-col">
        <ModalBody className="space-y-4">
          <RadioCards
            label="Provider"
            value={driver}
            onValueChange={setDriver}
            className="grid-cols-2"
            options={[
              { value: "claude", label: "Claude", description: "A Claude Code folder (CLAUDE_CONFIG_DIR)." },
              { value: "chatgpt", label: "ChatGPT", description: "A Codex home (CODEX_HOME)." },
            ]}
          />
          <Field label="Name" htmlFor="account-name">
            <input id="account-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={driver === "claude" ? "Claude Work" : "Codex Work"} autoFocus />
          </Field>
          <Field
            label="Folder"
            htmlFor="account-folder"
            hint={driver === "claude" ? "Its settings.json env (a proxy, say) and its login are used as they are." : "Signed in with Sign in on its row once it's added."}
          >
            <div className="flex items-center gap-2">
              <input
                id="account-folder"
                className="input min-w-0 flex-1 font-mono text-ui"
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
                placeholder={example}
                autoComplete="off"
                spellCheck={false}
              />
              {canPick && (
                <Button className="shrink-0" disabled={picking} onClick={() => void pick()}>
                  {picking ? <LoaderCircle className="animate-spin" /> : <FolderOpen />}
                  Choose…
                </Button>
              )}
            </div>
          </Field>
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <label htmlFor="account-tools" className="block text-sm font-medium text-fg">
                Use this account's MCP servers
              </label>
              <p className="mt-0.5 text-xs leading-relaxed text-fg-subtle">
                {driver === "claude" ? "The servers and plugins set up in this folder, alongside TOT's tools." : "The servers in its config.toml, alongside TOT's tools."}
              </p>
            </div>
            <Switch id="account-tools" checked={tools} onCheckedChange={setTools} />
          </div>
          {error && <Callout tone="danger">{error}</Callout>}
        </ModalBody>
        <ModalFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={saving || !name.trim() || !folder.trim()}>
            {saving ? "Adding…" : "Add account"}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

/** T3 Code's Claude and Codex instances that have their own folder, picked and added in one go. */
export function ImportT3Dialog({ open, onOpenChange, onImported }: { open: boolean; onOpenChange: (open: boolean) => void; onImported: (accounts: ProviderAccount[]) => void }) {
  const [candidates, setCandidates] = useState<T3ImportCandidate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [importing, setImporting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCandidates(null);
    setError(null);
    api.t3ImportCandidates().then(
      (list) => {
        setCandidates(list);
        setChosen(new Set(list.filter((c) => !c.alreadyAdded).map((c) => c.t3Id)));
      },
      (err: unknown) => setError(errorMessage(err)),
    );
  }, [open]);

  async function run() {
    setImporting(true);
    try {
      const added = await api.importFromT3([...chosen]);
      onImported(added);
      onOpenChange(false);
      toast.success(added.length === 1 ? "1 account imported" : `${added.length} accounts imported`);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setImporting(false);
    }
  }

  const toggle = (id: string, on: boolean) =>
    setChosen((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <Modal open={open} onOpenChange={onOpenChange} title="Import from T3 Code" description="Claude and Codex sign-ins T3 Code keeps in their own folders. TOT only reads T3 Code's settings." className="max-w-md">
      <ModalBody className="space-y-3">
        {error && <Callout tone="danger">{error}</Callout>}
        {!candidates && !error && (
          <div aria-busy="true" aria-label="Loading T3 Code's accounts" className="space-y-2">
            <Skeleton className="h-14 rounded-xl" />
            <Skeleton className="h-14 rounded-xl" />
          </div>
        )}
        {candidates?.length === 0 && <p className="text-sm text-fg-subtle">T3 Code has no Claude or Codex sign-ins in folders of their own. Its default ones are TOT's built-in accounts already.</p>}
        {candidates && candidates.length > 0 && (
          <ul className="divide-y divide-hairline rounded-xl border border-hairline">
            {candidates.map((candidate) => (
              <li key={candidate.t3Id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-fg">
                    {candidate.name} <span className="font-normal text-fg-subtle">· {PROVIDER_LABELS[candidate.driver]}</span>
                  </p>
                  <p className="truncate font-mono text-2xs text-fg-subtle">{candidate.configDir}</p>
                </div>
                {candidate.alreadyAdded ? (
                  <span className="text-xs text-fg-subtle">Added</span>
                ) : (
                  <Switch checked={chosen.has(candidate.t3Id)} onCheckedChange={(on) => toggle(candidate.t3Id, on)} label={`Import ${candidate.name}`} />
                )}
              </li>
            ))}
          </ul>
        )}
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button variant="primary" disabled={importing || chosen.size === 0 || !candidates} onClick={() => void run()}>
          {importing ? "Importing…" : "Import"}
        </Button>
      </ModalFooter>
    </Modal>
  );
}

/** Rename an account (the name shows in the model menu and in notices). */
export function RenameAccountDialog({ account, onOpenChange, onRenamed }: { account: AccountStatus | null; onOpenChange: (open: boolean) => void; onRenamed: (account: ProviderAccount) => void }) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => setName(account?.name ?? ""), [account]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!account) return;
    setSaving(true);
    try {
      onRenamed(await api.updateAccount(account.id, { name }));
      onOpenChange(false);
    } catch (err) {
      notifyError(err);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={account !== null} onOpenChange={onOpenChange} title="Rename account" className="max-w-sm">
      <form onSubmit={(event) => void submit(event)}>
        <ModalBody>
          <Field label="Name" htmlFor="rename-account">
            <input id="rename-account" className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
        </ModalBody>
        <ModalFooter divider={false}>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={saving || !name.trim()}>
            {saving ? "Saving…" : "Rename"}
          </Button>
        </ModalFooter>
      </form>
    </Modal>
  );
}

/** Claude signs in inside Claude Code itself: the command that opens it on the account's folder. */
export function ClaudeSignInDialog({ command, onOpenChange, onCheck }: { command: string | null; onOpenChange: (open: boolean) => void; onCheck: () => void }) {
  return (
    <Modal open={command !== null} onOpenChange={onOpenChange} title="Sign in to Claude" description="Run this in Terminal, type /login and follow the steps. Then check again here." className="max-w-md">
      <ModalBody>
        <div className="flex items-center gap-2 rounded-xl bg-sunken px-3 py-2.5">
          <code className="min-w-0 flex-1 truncate font-mono text-ui text-fg">{command}</code>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => void copyText(command ?? "").then((ok) => (ok ? toast.success("Copied") : toast.error("Couldn't copy. Select the command instead.")))}
          >
            <Copy /> Copy
          </Button>
        </div>
      </ModalBody>
      <ModalFooter>
        <Button variant="ghost" onClick={() => onOpenChange(false)}>
          Close
        </Button>
        <Button
          variant="primary"
          onClick={() => {
            onOpenChange(false);
            onCheck();
          }}
        >
          Check again
        </Button>
      </ModalFooter>
    </Modal>
  );
}
