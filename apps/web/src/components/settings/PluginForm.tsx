import { useState, type FormEvent } from "react";
import type { Plugin, ProviderId } from "@tot/shared/types";
import { api, errorMessage } from "../../lib/api";
import { PROVIDER_LABELS } from "../../lib/models";
import { EMPTY_PLUGIN_FORM, toPluginInput, type PluginFormValues } from "../../lib/plugins";
import { Button } from "../ui/Button";
import { Callout } from "../ui/Callout";
import { cardClass } from "../ui/Card";
import { Field } from "../ui/Field";
import { RadioCards } from "../ui/RadioCards";

type PluginFormProps = {
  existingNames: string[];
  onCreated: (plugin: Plugin) => void;
  onCancel: () => void;
};

const PROVIDERS: ProviderId[] = ["claude", "chatgpt"];

/** "Add plugin": an MCP server reachable over HTTP or started as a local command. */
export function PluginForm({ existingNames, onCreated, onCancel }: PluginFormProps) {
  const [values, setValues] = useState<PluginFormValues>(EMPTY_PLUGIN_FORM);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<PluginFormValues>) => {
    setValues((current) => ({ ...current, ...patch }));
    setError(null);
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    const input = toPluginInput(values, existingNames);
    if (typeof input === "string") {
      setError(input);
      return;
    }
    setSaving(true);
    try {
      onCreated(await api.createPlugin(input));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  const toggleProvider = (id: ProviderId, on: boolean) =>
    set({ providers: on ? [...new Set([...values.providers, id])] : values.providers.filter((p) => p !== id) });

  return (
    <form onSubmit={(event) => void submit(event)} className={cardClass({ className: "space-y-4" })}>
      <h3 className="text-sm font-semibold text-fg">Add plugin</h3>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="plugin-name" hint="Lowercase slug, e.g. “github”.">
          <input
            id="plugin-name"
            autoFocus
            value={values.name}
            onChange={(event) => set({ name: event.target.value.toLowerCase().replace(/\s+/g, "-") })}
            placeholder="github"
            autoComplete="off"
            spellCheck={false}
            className="input h-10 rounded-xl font-mono"
          />
        </Field>
        <Field label="Description" htmlFor="plugin-description" hint="Optional.">
          <input
            id="plugin-description"
            value={values.description}
            onChange={(event) => set({ description: event.target.value })}
            placeholder="Issues and pull requests"
            className="input h-10 rounded-xl"
          />
        </Field>
      </div>

      <RadioCards
        label="Plugin type"
        value={values.type}
        onValueChange={(type) => set({ type })}
        className="sm:grid-cols-2"
        options={[
          { value: "http", label: "HTTP", description: "A remote MCP server URL." },
          { value: "stdio", label: "stdio", description: "A command TOT starts on this machine." },
        ]}
      />

      {values.type === "http" ? (
        <>
          <Field label="URL" htmlFor="plugin-url">
            <input
              id="plugin-url"
              type="url"
              value={values.url}
              onChange={(event) => set({ url: event.target.value })}
              placeholder="https://mcp.example.com/mcp"
              spellCheck={false}
              className="input h-10 rounded-xl font-mono"
            />
          </Field>
          <Field label="Headers" htmlFor="plugin-headers" hint="Optional. One “Key: value” per line.">
            <textarea
              id="plugin-headers"
              rows={2}
              value={values.headers}
              onChange={(event) => set({ headers: event.target.value })}
              placeholder="Authorization: Bearer …"
              spellCheck={false}
              className="input resize-y rounded-xl font-mono"
            />
          </Field>
        </>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Command" htmlFor="plugin-command">
              <input
                id="plugin-command"
                value={values.command}
                onChange={(event) => set({ command: event.target.value })}
                placeholder="npx"
                spellCheck={false}
                className="input h-10 rounded-xl font-mono"
              />
            </Field>
            <Field label="Arguments" htmlFor="plugin-args" hint="Space-separated; quote to group.">
              <input
                id="plugin-args"
                value={values.args}
                onChange={(event) => set({ args: event.target.value })}
                placeholder="-y @modelcontextprotocol/server-github"
                spellCheck={false}
                className="input h-10 rounded-xl font-mono"
              />
            </Field>
          </div>
          <Field label="Environment" htmlFor="plugin-env" hint="Optional. One “KEY=value” per line.">
            <textarea
              id="plugin-env"
              rows={2}
              value={values.env}
              onChange={(event) => set({ env: event.target.value })}
              placeholder="GITHUB_TOKEN=…"
              spellCheck={false}
              className="input resize-y rounded-xl font-mono"
            />
          </Field>
        </>
      )}

      <fieldset>
        <legend className="mb-2 text-sm font-medium text-fg">Available to</legend>
        <div className="flex gap-5">
          {PROVIDERS.map((id) => (
            <label key={id} className="flex items-center gap-2 text-sm text-fg-muted">
              <input
                type="checkbox"
                checked={values.providers.includes(id)}
                onChange={(event) => toggleProvider(id, event.target.checked)}
                className="size-4 accent-fg"
              />
              {PROVIDER_LABELS[id]}
            </label>
          ))}
        </div>
      </fieldset>

      {error && <Callout tone="danger">{error}</Callout>}

      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={saving}>
          {saving ? "Adding…" : "Add plugin"}
        </Button>
      </div>
    </form>
  );
}
