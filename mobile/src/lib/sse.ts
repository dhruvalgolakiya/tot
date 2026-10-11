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
}

const MAX_DELAY_MS = 15_000;

/** Opens the stream; returns the function that closes it. */
export function openSse(options: SseOptions): () => void {
  let closed = false;
  let controller: AbortController | null = null;
  let lastId: string | null = null;
  let retryMs = 1000;
  let failures = 0;
  let opened = false;

  const run = async () => {
    while (!closed) {
      controller = new AbortController();
      let status = 0;
      try {
        const headers: Record<string, string> = { accept: "text/event-stream", ...options.headers() };
        if (lastId) headers["last-event-id"] = lastId;
        const response = await fetch(options.url(), { headers, signal: controller.signal });
        status = response.status;
        if (status === 204 || (status >= 400 && status < 500) || !response.body) {
          if (!closed) options.onEnd?.(status);
          return;
        }
        if (!response.ok) throw new Error(String(status));
        failures = 0;
        options.onOpen?.(opened);
        opened = true;
        await read(response.body, (field) => {
          if (field.retry) retryMs = field.retry;
          if (field.id !== null) lastId = field.id;
          if (field.data !== null && field.event === null) options.onMessage(field.data, field.id);
        });
      } catch {
        // Dropped, unreachable, or closed by us: retry below unless closed.
      }
      if (closed) return;
      failures++;
      await sleep(Math.min(retryMs * 2 ** Math.min(failures - 1, 4), MAX_DELAY_MS));
    }
  };
  void run();

  return () => {
    closed = true;
    controller?.abort();
  };
}

interface Field {
  id: string | null;
  event: string | null;
  data: string | null;
  retry: number | null;
}

async function read(body: ReadableStream<Uint8Array>, onEvent: (field: Field) => void) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
