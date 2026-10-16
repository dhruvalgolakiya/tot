import type { ProviderId, ProviderStatus } from "../../shared/types.ts";
import { limits } from "../agent/limits.ts";
import { providerStatuses, providers } from "../agent/providers/index.ts";
import { modelForWork } from "../agent/router.ts";

/**
 * One-shot model calls for trust work: drafting a profile and picking a playbook
 * (light) and reviewing a diff (heavy). Tool-less and without any chat's
 * transcript, so a reviewer starts with nothing but what it's shown. Tests swap
 * the backend for a fake.
 */

export interface ModelCall {
  provider: ProviderId;
  model: string;
  prompt: string;
  system: string;
  signal?: AbortSignal;
}

interface ModelBackend {
  statuses(): Promise<ProviderStatus[]>;
  complete(call: ModelCall): Promise<string>;
}

const real: ModelBackend = {
  statuses: () => providerStatuses(),
  complete: ({ provider, model, prompt, system, signal }) => providers[provider].complete(prompt, { model, system, signal }),
};

let backend = real;

export interface Answer {
  text: string;
  provider: ProviderId;
  model: string;
}

export const trustModel = {
  /** Providers that can take a call now: logged in and not in a usage-limit cooldown. */
  async available(): Promise<ProviderId[]> {
    const statuses = await backend.statuses();
    const limited = limits.active();
    return (["claude", "chatgpt"] as const).filter((id) => statuses.find((s) => s.id === id)?.loggedIn && !limited.has(id));
  },

  /** Asks `prefer` when it's available, else the other provider. Throws when neither is. */
  async ask(opts: { prompt: string; system: string; heavy: boolean; prefer?: ProviderId; timeoutMs?: number }): Promise<Answer> {
    const statuses = await backend.statuses();
    const up = await trustModel.available();
    const provider = opts.prefer && up.includes(opts.prefer) ? opts.prefer : up[0];
    const model = provider ? modelForWork(provider, opts.heavy, statuses) : null;
    if (!provider || !model) throw new Error("No model provider is connected. Connect Claude or ChatGPT in Settings → Models.");
    const signal = AbortSignal.timeout(opts.timeoutMs ?? 5 * 60_000);
    const text = await backend.complete({ provider, model, prompt: opts.prompt, system: opts.system, signal });
    return { text, provider, model };
  },

  /** Tests: answer with a fake instead of the real models. */
  use(fake: ModelBackend | null): void {
    backend = fake ?? real;
  },
};

/** The first JSON object in a model's answer (which may come wrapped in prose or a code fence). */
export function jsonIn(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("The answer has no JSON object.");
  return JSON.parse(text.slice(start, end + 1));
}
