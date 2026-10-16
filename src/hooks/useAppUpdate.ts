import { useEffect, useState } from "react";
import { totDesktop, type AppUpdateState } from "../lib/desktop";

const IDLE: AppUpdateState = { status: "idle" };

/**
 * The Mac app's downloaded update, once it's ready to install and the user hasn't dismissed it: its version,
 * or `null`. Always `null` in a browser, on a phone, and in Mac apps without updates.
 */
export function useAppUpdate(): string | null {
  const [state, setState] = useState<AppUpdateState>(IDLE);
  useEffect(() => totDesktop?.updates?.onState(setState), []);
  return state.status === "ready" && !state.dismissed ? state.version : null;
}
