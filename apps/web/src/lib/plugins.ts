import type { PluginConfig, PluginInput, ProviderId } from "@tot/shared/types";

export interface PluginFormValues {
  name: string;
  description: string;
  type: PluginConfig["type"];
  url: string;
  /** One `Key: value` per line. */
  headers: string;
  command: string;
  /** Space-separated; quotes group words. */
  args: string;
  /** One `KEY=value` per line. */
  env: string;
  providers: ProviderId[];
}

export const EMPTY_PLUGIN_FORM: PluginFormValues = {
  name: "",
  description: "",
  type: "http",
  url: "",
  headers: "",
  command: "",
  args: "",
  env: "",
  providers: ["claude", "chatgpt"],
};

const SLUG = /^[a-z0-9][a-z0-9_-]*$/;

/** Split a command line into arguments: `--root "/my dir" -v` → ["--root", "/my dir", "-v"]. */
export function splitArgs(text: string): string[] {
  return [...text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
}

function parseLines(text: string, separator: ":" | "=", what: string): Record<string, string> | string {
  const result: Record<string, string> = {};
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.trim();
    if (!line) continue;
    const at = line.indexOf(separator);
    const key = at > 0 ? line.slice(0, at).trim() : "";
    if (!key) return `${what} line ${index + 1} should look like “${separator === ":" ? "Key: value" : "KEY=value"}”.`;
    result[key] = line.slice(at + 1).trim();
  }
  return result;
}

/** Validate the Add plugin form. Returns the request body, or an error message. */
export function toPluginInput(values: PluginFormValues, existingNames: string[]): PluginInput | string {
  const name = values.name.trim();
  if (!name) return "Give the plugin a name.";
  if (!SLUG.test(name)) return "Names use lowercase letters, numbers, - and _ (e.g. “github”).";
  if (existingNames.includes(name)) return `A plugin named “${name}” already exists.`;
  if (values.providers.length === 0) return "Pick at least one provider.";

  let config: PluginConfig;
  if (values.type === "http") {
    const url = values.url.trim();
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
    } catch {
      return "Enter the server's http(s) URL.";
    }
    const headers = parseLines(values.headers, ":", "Header");
    if (typeof headers === "string") return headers;
    config = { type: "http", url, ...(Object.keys(headers).length ? { headers } : {}) };
  } else {
    const command = values.command.trim();
    if (!command) return "Enter the command that starts the server.";
    const args = splitArgs(values.args);
    const env = parseLines(values.env, "=", "Env");
    if (typeof env === "string") return env;
    config = {
      type: "stdio",
      command,
      ...(args.length ? { args } : {}),
      ...(Object.keys(env).length ? { env } : {}),
    };
  }

  return {
    name,
    ...(values.description.trim() ? { description: values.description.trim() } : {}),
    config,
    enabled: true,
    providers: values.providers,
  };
}

export function pluginTarget(config: PluginConfig): string {
  return config.type === "http" ? config.url : [config.command, ...(config.args ?? [])].join(" ");
}
