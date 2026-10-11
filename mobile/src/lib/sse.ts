/**
 * Server-Sent Events over fetch (roadmap module 14). React Native has no EventSource, and EventSource can't
 * send the Bearer header anyway, so this reads the stream body itself (expo/fetch, the global fetch on iOS and
 * Android, streams). It reconnects like EventSource: after the server's `retry` delay, with Last-Event-ID so a
 * run stream replays what was missed. A 204 or a 4xx ends it for good.
 */

export interface SseOptions {
  url: () => string;
  headers: () => Record<string, string>;
  onMessage: (data: string, id: string | null) => void;
  /** Each time the stream is (re)connected. `again` is true after the first time: refetch whatever you cache. */
  onOpen?: (again: boolean) => void;
  /** It ended for good: the status that ended it (204 for a finished run stream). */
  onEnd?: (status: number) => void;
  /** A connect failed or a live stream dropped; it retries by itself, with backoff. */
  onDrop?: () => void;
}

/** Closes the stream; `retryNow` cuts a backoff wait short (the app came back, or the user tapped Retry). */
export interface SseHandle {
  (): void;
  retryNow: () => void;
}

const MAX_DELAY_MS = 15_000;
/** A TOT that's gone (a Mac asleep, off Tailscale) often doesn't refuse: the request just hangs. Give up on it after this. */
const CONNECT_TIMEOUT_MS = 12_000;
/**
 * TOT's streams send a heartbeat every 15 s (server/routes.ts). A connection that stays silent much longer than that is
 * dead without having said so (the Mac slept, Wi‑Fi changed): drop it and reconnect.
 */
const IDLE_TIMEOUT_MS = 40_000;

/** Opens the stream; returns the function that closes it. */
export function openSse(options: SseOptions): SseHandle {
  let closed = false;
  let controller: AbortController | null = null;
  let lastId: string | null = null;
  let retryMs = 1000;
  let failures = 0;
  let opened = false;
  let wake: (() => void) | null = null;

  const run = async () => {
    while (!closed) {
      controller = new AbortController();
      let status = 0;
      try {
        const headers: Record<string, string> = { accept: "text/event-stream", ...options.headers() };
        if (lastId) headers["last-event-id"] = lastId;
        const connecting = controller;
        const timeout = setTimeout(() => connecting.abort(), CONNECT_TIMEOUT_MS);
        const response = await fetch(options.url(), { headers, signal: controller.signal }).finally(() => clearTimeout(timeout));
        status = response.status;
        if (status === 204 || (status >= 400 && status < 500) || !response.body) {
          if (!closed) options.onEnd?.(status);
          return;
        }
        if (!response.ok) throw new Error(String(status));
        failures = 0;
        options.onOpen?.(opened);
        opened = true;
        const live = controller;
        let idle = setTimeout(() => live.abort(), IDLE_TIMEOUT_MS);
        const alive = () => {
          clearTimeout(idle);
          idle = setTimeout(() => live.abort(), IDLE_TIMEOUT_MS);
        };
        await read(response.body, alive, (field) => {
          if (field.retry) retryMs = field.retry;
          if (field.id !== null) lastId = field.id;
          if (field.data !== null && field.event === null) options.onMessage(field.data, field.id);
        }).finally(() => clearTimeout(idle));
      } catch {
        // Dropped, unreachable, or closed by us: retry below unless closed.
      }
      if (closed) return;
      failures++;
      options.onDrop?.();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(done, Math.min(retryMs * 2 ** Math.min(failures - 1, 4), MAX_DELAY_MS));
        function done() {
          clearTimeout(timer);
          wake = null;
          resolve();
        }
        wake = done;
      });
    }
  };
  void run();

  const close = (() => {
    closed = true;
    controller?.abort();
    wake?.();
  }) as SseHandle;
  close.retryNow = () => wake?.();
  return close;
}

interface Field {
  id: string | null;
  event: string | null;
  data: string | null;
  retry: number | null;
}

async function read(body: ReadableStream<Uint8Array>, onChunk: () => void, onEvent: (field: Field) => void) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    onChunk();
    buffer += decoder.decode(value, { stream: true });
    // Events end with a blank line; keep any unfinished one for the next chunk.
    let end: number;
    while ((end = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end).replace(/^\r?\n\r?\n/, "");
      const field: Field = { id: null, event: null, data: null, retry: null };
      for (const line of block.split(/\r?\n/)) {
        if (!line || line.startsWith(":")) continue;
        const colon = line.indexOf(":");
        const name = colon === -1 ? line : line.slice(0, colon);
        const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
        if (name === "data") field.data = field.data === null ? value : `${field.data}\n${value}`;
        else if (name === "id") field.id = value;
        else if (name === "event") field.event = value;
        else if (name === "retry" && /^\d+$/.test(value)) field.retry = Number(value);
      }
      onEvent(field);
    }
  }
}

