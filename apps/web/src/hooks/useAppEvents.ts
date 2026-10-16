import { useEffect, useRef, useState } from "react";
import type { AppEvent } from "@shared/types";
import { adopt } from "../lib/devices";

/**
 * App-wide live updates: one shared EventSource for GET /api/events across
 * every caller on the page (reference-counted, like ../lib/stream.ts does
 * per-run). There is no replay, so `onReconnect` is your cue to refetch
 * whatever list/detail you're caching.
 */

/** `deviceId` is set for a paired device's event (module 07): its agents, chats and projects. */
type OnEvent = (event: AppEvent, deviceId: string | null) => void;

interface Listener {
  onEvent: OnEvent;
  onReconnect?: () => void;
}

let source: EventSource | null = null;
const listeners = new Set<Listener>();
/** Set on the first `error` after a connection was up; cleared on the next successful `open`. */
let hadError = false;

function openChannel(): EventSource {
  const es = new EventSource("/api/events");

  es.onmessage = (message: MessageEvent<string>) => {
    // The initial named "ready" event (and any other control message) carries no data.
    if (!message.data) return;
    let event: AppEvent;
    try {
      event = JSON.parse(message.data) as AppEvent;
    } catch {
      return;
    }
    // A paired device's event arrives wrapped; unwrapped here, its ids and file URLs become that device's.
    const deviceId = event.type === "remote" ? event.deviceId : null;
    if (event.type === "remote") event = adopt(event.deviceId, event.event);
    for (const listener of [...listeners]) listener.onEvent(event, deviceId);
  };

  es.onerror = () => {
    hadError = true;
  };

  es.onopen = () => {
    // EventSource auto-reconnects on its own; `open` firing again after an
    // `error` is exactly the signal that a reconnect just succeeded.
    if (!hadError) return;
    hadError = false;
    for (const listener of [...listeners]) listener.onReconnect?.();
  };

  return es;
}

function subscribe(listener: Listener): () => void {
  if (!source) source = openChannel();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && source) {
      source.close();
      source = null;
      hadError = false;
    }
  };
}

/**
 * Subscribes to app-wide live updates for as long as the calling component
 * is mounted. `onEvent`/`onReconnect` are read through refs, so passing new
 * function identities on every render never tears down or reopens the
 * shared connection.
 */
export function useAppEvents(onEvent: OnEvent, onReconnect?: () => void): void {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const onReconnectRef = useRef(onReconnect);
  onReconnectRef.current = onReconnect;

  useEffect(() => {
    const listener: Listener = {
      onEvent: (event, deviceId) => onEventRef.current(event, deviceId),
      onReconnect: () => onReconnectRef.current?.(),
    };
    return subscribe(listener);
  }, []);
}

/** Agent ids with at least one run currently in flight (background routines included). */
export function useRunningAgents(): Set<string> {
  const [running, setRunning] = useState<Set<string>>(() => new Set());

  useAppEvents((event) => {
    if (event.type !== "run") return;
    setRunning((current) => {
      const isRunning = event.status === "running";
      if (current.has(event.agentId) === isRunning) return current;
      const next = new Set(current);
      if (isRunning) next.add(event.agentId);
      else next.delete(event.agentId);
      return next;
    });
  });

  return running;
}
