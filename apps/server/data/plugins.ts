import { randomUUID } from "node:crypto";
import type { Plugin, PluginConfig, PluginInput, ProviderId } from "@tot/shared/types";
import { db, parseJson, type Row } from "../db.ts";

const NAME_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const RESERVED_NAMES = new Set(["tot"]);
const ALL_PROVIDERS: ProviderId[] = ["claude", "chatgpt"];

function toPlugin(row: Row): Plugin {
  return {
    id: String(row.id),
    name: String(row.name),
    description: (row.description as string | null) ?? undefined,
    config: parseJson<PluginConfig>(row.config, { type: "http", url: "" }),
    enabled: Boolean(row.enabled),
    providers: parseJson<ProviderId[]>(row.providers, ALL_PROVIDERS),
    createdAt: Number(row.created_at),
  };
}

export function validatePlugin(input: Partial<PluginInput>): string | null {
  if (input.name !== undefined) {
    if (!NAME_PATTERN.test(input.name)) return "Name must be a lowercase slug (a-z, 0-9, - or _), max 32 chars.";
    if (RESERVED_NAMES.has(input.name)) return `"${input.name}" is reserved.`;
  }
  const config = input.config;
  if (config) {
    if (config.type === "http") {
      try {
        const url = new URL(config.url);
        if (!/^https?:$/.test(url.protocol)) return "Plugin URL must be http(s).";
      } catch {
        return "Plugin URL is not valid.";
      }
    } else if (config.type === "stdio") {
      if (!config.command?.trim()) return "A stdio plugin needs a command.";
    } else {
      return "Plugin type must be http or stdio.";
    }
  }
  if (input.providers && input.providers.some((p) => !ALL_PROVIDERS.includes(p))) return "Unknown provider.";
  return null;
}

export const plugins = {
  list(): Plugin[] {
    return (db.prepare(`SELECT * FROM plugins ORDER BY created_at`).all() as Row[]).map(toPlugin);
  },

  get(id: string): Plugin | null {
    const row = db.prepare(`SELECT * FROM plugins WHERE id = ?`).get(id) as Row | undefined;
    return row ? toPlugin(row) : null;
  },

  create(input: PluginInput): Plugin {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO plugins (id, name, description, config, enabled, providers, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.name,
      input.description ?? null,
      JSON.stringify(input.config),
      Number(input.enabled ?? true),
      JSON.stringify(input.providers ?? ALL_PROVIDERS),
      Date.now(),
    );
    return plugins.get(id)!;
  },

  update(id: string, patch: Partial<PluginInput>): Plugin | null {
    const columns: Record<string, string | number | null | undefined> = {
      name: patch.name,
      description: patch.description,
      config: patch.config && JSON.stringify(patch.config),
      enabled: patch.enabled === undefined ? undefined : Number(patch.enabled),
      providers: patch.providers && JSON.stringify(patch.providers),
    };
    const entries = Object.entries(columns).filter(([, v]) => v !== undefined);
    if (entries.length) {
      db.prepare(`UPDATE plugins SET ${entries.map(([k]) => `${k} = ?`).join(", ")} WHERE id = ?`).run(
        ...(entries.map(([, v]) => v) as (string | number | null)[]),
        id,
      );
    }
    return plugins.get(id);
  },

  delete(id: string): boolean {
    return db.prepare(`DELETE FROM plugins WHERE id = ?`).run(id).changes > 0;
  },

  enabledFor(provider: ProviderId): Plugin[] {
    return plugins.list().filter((p) => p.enabled && p.providers.includes(provider));
  },
};
