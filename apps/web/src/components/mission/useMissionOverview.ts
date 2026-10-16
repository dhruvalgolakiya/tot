import { useCallback, useEffect, useRef, useState } from "react";
import type { MissionOverview } from "@tot/shared/types";
import { useAppEvents } from "../../hooks/useAppEvents";
import { api, errorMessage } from "../../lib/api";

/**
 * Mission control's overview (module 09) for one project or all, kept live: refetched shortly after any
 * task changes (a burst gives one fetch) and on reconnect. Used by the board page and, compact, by a
 * project's page (module 11).
 */

const REFETCH_MS = 600;

export type MissionState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; overview: MissionOverview };

export function useMissionOverview(projectId: string | null): { state: MissionState; reload: () => void } {
  const [state, setState] = useState<MissionState>({ status: "loading" });
  const request = useRef(0);

  const load = useCallback(async () => {
    const id = ++request.current;
    try {
      const overview = await api.getMission({ projectId });
      if (id === request.current) setState({ status: "ready", overview });
    } catch (error) {
      if (id === request.current) setState((current) => (current.status === "ready" ? current : { status: "error", message: errorMessage(error) }));
    }
  }, [projectId]);

  useEffect(() => {
    setState({ status: "loading" });
    void load();
  }, [load]);

  // Live: any task changing (or going away) refetches the overview, a moment later so a burst gives one fetch.
  const timer = useRef<number | undefined>(undefined);
  const schedule = useCallback(() => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void load(), REFETCH_MS);
  }, [load]);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useAppEvents(
    (event) => {
      if (event.type === "task" || event.type === "conversation-deleted") schedule();
    },
    () => void load(),
  );

  return { state, reload: () => void load() };
}
