import type { RunEvent } from "@shared/types";
import { adopt, apiUrl, deviceOf } from "./devices";

export interface RunListener {
  onEvent: (event: RunEvent) => void;
  /**
   * The stream closed for good without a `run-end` — e.g. the server answered
   * with an error status, so EventSource won't reconnect on its own.
   */
  onLost?: () => void;
}

interface Channel {
  source: EventSource;
  listeners: Set<RunListener>;
}

/** One EventSource per run, shared by every listener of that run. */
const channels = new Map<string, Channel>();

export function runEventsUrl(runId: string): string {
  return apiUrl(`/runs/${encodeURIComponent(runId)}/events`, deviceOf(runId));
}

/**
 * Follow a run's events. Transient network drops are handled by EventSource's
 * native reconnect (the server replays everything after Last-Event-ID). The
 * stream closes itself after `run-end`. Returns an unsubscribe function.
 */
export function subscribeToRun(runId: string, listener: RunListener): () => void {
  const channel = channels.get(runId) ?? openChannel(runId);
  channel.listeners.add(listener);

  return () => {
    if (!channel.listeners.delete(listener)) return;
    if (channel.listeners.size === 0) closeChannel(runId, channel);
  };
}

function openChannel(runId: string): Channel {
  const source = new EventSource(runEventsUrl(runId));
  const channel: Channel = { source, listeners: new Set() };
  channels.set(runId, channel);

  source.onmessage = (message: MessageEvent<string>) => {
    let event: RunEvent;
    try {
      event = JSON.parse(message.data) as RunEvent;
    } catch {
      return; // Not a RunEvent (e.g. a keep-alive payload).
    }
    // Another device's run (module 07): its ids and file URLs belong to it.
    const device = deviceOf(runId);
    if (device) adopt(device, event);
    if (event.type === "run-end") closeChannel(runId, channel);
    for (const listener of [...channel.listeners]) listener.onEvent(event);
  };

  source.onerror = () => {
    // CONNECTING means the browser is already retrying with Last-Event-ID.
    if (source.readyState !== EventSource.CLOSED) return;
    closeChannel(runId, channel);
    for (const listener of [...channel.listeners]) listener.onLost?.();
  };

  return channel;
}

function closeChannel(runId: string, channel: Channel) {
  channel.source.close();
  if (channels.get(runId) === channel) channels.delete(runId);
}
