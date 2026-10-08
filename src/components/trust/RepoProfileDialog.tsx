import { useEffect, useState, type FormEvent } from "react";
import { LoaderCircle, Play, ShieldCheck } from "lucide-react";
import type { Agent, Brain, CommandRun, RepoCommandName, RepoProfile, RepoProfileInput } from "@shared/types";
import { errorMessage } from "../../lib/api";
import { formatDuration } from "../../lib/format";
import { ToolOutput } from "../ToolOutput";
import { Badge } from "../ui/Badge";
import { Button } from "../ui/Button";
import { Callout } from "../ui/Callout";
import { EmptyState } from "../ui/EmptyState";
import { IconButton } from "../ui/IconButton";
import { Modal, ModalBody, ModalFooter } from "../ui/Modal";
import { SectionHeader } from "../ui/SectionHeader";
import { Skeleton } from "../ui/Skeleton";
import { Switch } from "../ui/Switch";
import { Tip } from "../ui/Tip";
import { SettingRow } from "../settings/SettingRow";
import { ChipInput, RuleList } from "./ListEditors";
import { trustApi } from "./trustApi";

const COMMANDS: { name: RepoCommandName; label: string; placeholder: string }[] = [
  { name: "install", label: "Install", placeholder: "npm ci" },
  { name: "typecheck", label: "Typecheck", placeholder: "npx tsc --noEmit" },
  { name: "lint", label: "Lint", placeholder: "npm run lint" },
  { name: "test", label: "Test", placeholder: "npm test" },
  { name: "testFile", label: "Test one file", placeholder: "npx vitest run {file}" },
  { name: "build", label: "Build", placeholder: "npm run build" },
  { name: "e2e", label: "End-to-end", placeholder: "npx playwright test" },
];

type RunState = CommandRun | "running" | { error: string };

type RepoProfileDialogProps = {
  brain: Brain;
  /** Whose computer drafts and runs commands: the agent whose wiki is open. */
  agent: Agent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

const toInput = ({ commands, conventions, protectedPaths, definitionOfDone, limits }: RepoProfile): RepoProfileInput => ({
  commands,
  conventions,
  protectedPaths,
  definitionOfDone,
  limits,
});

const formatDate = (at: number) => new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });

/** What "correct" means in a repo: the commands TOT checks work with, conventions, protected paths and limits. */
export function RepoProfileDialog({ brain, agent, open, onOpenChange }: RepoProfileDialogProps) {
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saved, setSaved] = useState<RepoProfile | null | undefined>(undefined);
  const [form, setForm] = useState<RepoProfileInput | null>(null);
  const [drafted, setDrafted] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [runs, setRuns] = useState<Partial<Record<RepoCommandName, RunState>>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setLoadError(null);
    setSaved(undefined);
    trustApi.profile(brain.id).then(
      (profile) => {
        setSaved(profile);
        setForm(profile ? toInput(profile) : null);
      },
      (err: unknown) => setLoadError(errorMessage(err)),
    );
  }

  useEffect(() => {
    if (!open) return;
    setDrafted(false);
    setRuns({});
    setError(null);
    setSaving(false);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload only when (re)opened or another brain is shown
  }, [open, brain.id]);

  async function draft() {
    setDrafting(true);
    setError(null);
    try {
      setForm(toInput(await trustApi.draftProfile(brain.id, agent.id)));
      setDrafted(true);
      setRuns({});
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setDrafting(false);
    }
  }

  async function runCommand(name: RepoCommandName, command: string) {
    setRuns((current) => ({ ...current, [name]: "running" }));
    try {
      const result = await trustApi.runCommand(brain.id, agent.id, command);
      setRuns((current) => ({ ...current, [name]: result }));
    } catch (err) {
      setRuns((current) => ({ ...current, [name]: { error: errorMessage(err) } }));
    }
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!form || saving) return;
    setSaving(true);
    setError(null);
    try {
      const profile = await trustApi.saveProfile(brain.id, {
        ...form,
        conventions: form.conventions.filter((item) => item.trim()),
        definitionOfDone: form.definitionOfDone.filter((item) => item.trim()),
      });
      setSaved(profile);
      onOpenChange(false);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const patch = (next: Partial<RepoProfileInput>) => setForm((current) => (current ? { ...current, ...next } : current));
  const setLimit = (key: "maxChangedLines" | "maxChangedFiles" | "commandTimeoutMinutes", value: string) =>
    form && patch({ limits: { ...form.limits, [key]: Number(value) || 0 } });

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Repo profile"
      description={`What “correct” means in ${brain.name}: the checks TOT runs on agents' work, and what they must ask about first.`}
      className="flex max-w-xl flex-col"
    >
      <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
        <ModalBody className="space-y-6">
          {loadError ? (
            <Callout
              tone="danger"
              action={
                <button type="button" onClick={load} className="link-muted">
                  Try again
                </button>
              }
            >
              {loadError}
            </Callout>
          ) : saved === undefined ? (
            <div className="space-y-3" aria-busy="true" aria-label="Loading the repo profile">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-5/6" />
            </div>
          ) : !form ? (
            <EmptyState
              icon={<ShieldCheck />}
              title="No profile yet"
              description={`TOT drafts one from the repo's manifests on ${agent.name}'s computer and what agents learned about it. You review it before it's used.`}
              action={
                <Button type="button" variant="primary" onClick={() => void draft()} disabled={drafting}>
                  {drafting ? "Drafting…" : "Draft from code"}
                </Button>
              }
            />
          ) : (
            <>
              {drafted ? (
                <Callout tone="info">Drafted from the code. Check the commands with Run, then save.</Callout>
              ) : (
                saved && (
                  <p className="text-xs text-fg-subtle">
                    {saved.updatedBy === "user" ? "Edited by you" : "Drafted from the code"} on {formatDate(saved.updatedAt)}
                  </p>
                )
              )}

              <section className="space-y-3">
                <SectionHeader
                  as="h3"
                  title="Commands"
                  description={`Run in the repo's folder on ${agent.name}'s computer. Leave one empty to skip that check.`}
                />
                <div className="space-y-2">
                  {COMMANDS.map(({ name, label, placeholder }) => (
                    <CommandRow
                      key={name}
                      label={label}
                      value={form.commands[name] ?? ""}
                      placeholder={placeholder}
                      onChange={(value) => patch({ commands: { ...form.commands, [name]: value } })}
                      onRun={name === "testFile" ? undefined : () => void runCommand(name, form.commands[name] ?? "")}
                      run={runs[name]}
                    />
                  ))}
                </div>
              </section>

              <section className="space-y-3">
                <SectionHeader as="h3" title="Conventions" description="Short rules agents follow in this code. Reviewers check them too." />
                <RuleList
                  label="Conventions"
                  items={form.conventions}
                  onChange={(conventions) => patch({ conventions })}
                  placeholder="e.g. Prices are integers in cents"
                  addLabel="Add convention"
                />
              </section>

              <section className="space-y-3">
                <SectionHeader as="h3" title="Protected paths" description="Agents ask you before changing these. Globs like migrations/** work." />
                <ChipInput
                  label="Protected paths"
                  values={form.protectedPaths}
                  onChange={(protectedPaths) => patch({ protectedPaths })}
                  placeholder="Add a path or glob, then press Enter"
                  mono
                />
              </section>

              <section className="space-y-3">
                <SectionHeader as="h3" title="Definition of done" description="What a finished change must meet in this repo." />
                <RuleList
                  label="Definition of done"
                  items={form.definitionOfDone}
                  onChange={(definitionOfDone) => patch({ definitionOfDone })}
                  placeholder="e.g. Docs updated for public APIs"
                  addLabel="Add item"
                />
              </section>

              <section className="space-y-3">
                <SectionHeader as="h3" title="Limits" description="Bigger changes need your OK." />
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                  <NumberField id="limit-lines" label="Changed lines" value={form.limits.maxChangedLines} onChange={(v) => setLimit("maxChangedLines", v)} />
                  <NumberField id="limit-files" label="Changed files" value={form.limits.maxChangedFiles} onChange={(v) => setLimit("maxChangedFiles", v)} />
                  <NumberField
                    id="limit-timeout"
                    label="Command timeout (min)"
                    value={form.limits.commandTimeoutMinutes}
                    onChange={(v) => setLimit("commandTimeoutMinutes", v)}
                  />
                </div>
                <SettingRow
                  className="border-t border-hairline"
                  title="Allow new dependencies"
                  description="Off: adding a package or changing a lockfile waits for your OK."
                  control={
                    <Switch
                      checked={form.limits.allowNewDependencies}
                      onCheckedChange={(allowNewDependencies) => patch({ limits: { ...form.limits, allowNewDependencies } })}
                      label="Allow new dependencies"
                    />
                  }
                />
              </section>
            </>
          )}

          {error && <Callout tone="danger">{error}</Callout>}
        </ModalBody>

        {form && (
          <ModalFooter>
            <Button type="button" variant="ghost" className="mr-auto" onClick={() => void draft()} disabled={drafting}>
              {drafting ? "Drafting…" : "Draft from code"}
            </Button>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </ModalFooter>
        )}
      </form>
    </Modal>
  );
}

function CommandRow({
  label,
  value,
  placeholder,
  onChange,
  onRun,
  run,
}: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  /** Missing for commands that need a file. */
  onRun?: () => void;
  run?: RunState;
}) {
  const running = run === "running";
  const id = `command-${label.toLowerCase().replace(/\W+/g, "-")}`;
  return (
    <div>
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="w-28 shrink-0 text-ui text-fg-muted">
          {label}
        </label>
        <input
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          spellCheck={false}
          className="input input-sm min-w-0 flex-1 rounded-lg font-mono"
        />
        <Tip content={onRun ? "Run now" : "Runs on one test file during tasks"}>
          <span className="inline-flex">
            <IconButton label={`Run ${label.toLowerCase()} now`} size="sm" onClick={onRun} disabled={!onRun || !value.trim() || running}>
              {running ? <LoaderCircle className="animate-spin" /> : <Play />}
            </IconButton>
          </span>
        </Tip>
      </div>
      {run && run !== "running" && (
        <div className="mt-2 space-y-2 sm:pl-30">
          {"error" in run ? (
            <Callout tone="danger">{run.error}</Callout>
          ) : (
            <>
              <div className="flex items-center gap-2 text-xs text-fg-subtle tabular-nums">
                <Badge tone={run.timedOut ? "warning" : run.exitCode === 0 ? "success" : "danger"} dot>
                  {run.timedOut ? "Timed out" : run.exitCode === 0 ? "Passed" : `Exit ${run.exitCode}`}
                </Badge>
                {formatDuration(run.durationMs)}
              </div>
              {run.outputTail && <ToolOutput label="Output" text={run.outputTail} error={run.exitCode !== 0} startAtEnd />}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function NumberField({ id, label, value, onChange }: { id: string; label: string; value: number; onChange: (value: string) => void }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-xs text-fg-muted">
        {label}
      </label>
      <input
        id={id}
        type="number"
        inputMode="numeric"
        min={1}
        value={value || ""}
        onChange={(event) => onChange(event.target.value)}
        className="input input-sm rounded-lg tabular-nums"
      />
    </div>
  );
}
