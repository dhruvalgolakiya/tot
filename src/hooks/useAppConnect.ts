import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { AppConnectStep, AppKeyField } from "@shared/types";
import { api, errorMessage } from "../lib/api";
import { loadAppsStatus, setAppsStatus } from "../store";

export type ConnectFlowState =
  | { kind: "loading"; appId: string; name: string }
  | { kind: "sign-in-remote"; appId: string; name: string }
  | { kind: "waiting"; appId: string; name: string; fallbackUrl: string | null }
  | { kind: "key"; appId: string; name: string; fields: AppKeyField[]; help: { label: string; url: string } | null }
  | { kind: "client"; appId: string; name: string; provider: string; redirectUri: string; consoleUrl: string | null }
  | { kind: "error"; appId: string; name: string; message: string };

const POPUP_FEATURES = "popup,width=520,height=720";
const POLL_MS = 2_000;

function openPopup(): Window | null {
  const popup = window.open("about:blank", "tot-signin", POPUP_FEATURES);
  if (popup) popup.opener = null;
  return popup;
}

/**
 * Drives POST /api/apps/connect end to end: the sign-in pop-up + poll, the API
 * key form, and the guided OAuth-client setup. Call `start` directly from a
 * click handler (not after an await) so a pop-up it opens isn't blocked.
 */
export function useAppConnect() {
  const [flow, setFlow] = useState<ConnectFlowState | null>(null);
  const popupRef = useRef<Window | null>(null);
  const flowIdRef = useRef<string | null>(null);
  const pollRef = useRef<number | undefined>(undefined);
  // Sign-ins only finish in a browser on the Mac running TOT; defaults to true until known.
  const localRef = useRef(true);

  useEffect(() => {
    api.getAppsAccess().then(
      ({ onThisMachine }) => {
        localRef.current = onThisMachine;
      },
      () => {},
    );
  }, []);

  useEffect(
    () => () => {
      window.clearInterval(pollRef.current);
      popupRef.current?.close();
      if (flowIdRef.current) void api.cancelAppConnect(flowIdRef.current).catch(() => {});
    },
    [],
  );

  function closePopup() {
    popupRef.current?.close();
    popupRef.current = null;
  }

  function handleStep(appId: string, name: string, step: AppConnectStep) {
    switch (step.step) {
      case "connected":
        closePopup();
        flowIdRef.current = null;
        toast.success(`${name} connected`);
        setAppsStatus(step.status);
        setFlow(null);
        break;
      case "sign-in": {
        if (!localRef.current) {
          closePopup();
          setFlow({ kind: "sign-in-remote", appId, name });
          break;
        }
        let popup = popupRef.current;
        if (popup && !popup.closed) popup.location.href = step.url;
        else popup = window.open(step.url, "tot-signin", POPUP_FEATURES);
        popupRef.current = popup;
        flowIdRef.current = step.flowId;
        setFlow({ kind: "waiting", appId, name, fallbackUrl: popup ? null : step.url });
        startPolling(appId, name, step.flowId);
        break;
      }
      case "key":
        closePopup();
        setFlow({ kind: "key", appId, name, fields: step.fields, help: step.help });
        break;
      case "client":
        closePopup();
        setFlow({ kind: "client", appId, name, provider: step.provider, redirectUri: step.redirectUri, consoleUrl: step.consoleUrl });
        break;
    }
  }

  function startPolling(appId: string, name: string, flowId: string) {
    window.clearInterval(pollRef.current);
    pollRef.current = window.setInterval(async () => {
      let poll;
      try {
        poll = await api.pollAppConnect(flowId);
      } catch {
        return; // Transient hiccup; keep polling until the flow expires on its own.
      }
      if (poll.state === "pending") return;
      window.clearInterval(pollRef.current);
      closePopup();
      flowIdRef.current = null;
      if (poll.state === "connected") {
        toast.success(`${name} connected`);
        void loadAppsStatus();
        setFlow(null);
      } else {
        setFlow({ kind: "error", appId, name, message: poll.error ?? "Something went wrong." });
      }
    }, POLL_MS);
  }

  /** Call directly from a click handler. `presumeSignIn` opens the pop-up synchronously, before the request, so it isn't blocked. */
  function start(appId: string, name: string, presumeSignIn = false) {
    window.clearInterval(pollRef.current);
    flowIdRef.current = null;
    const popup = presumeSignIn ? openPopup() : null;
    popupRef.current = popup;
    setFlow({ kind: "loading", appId, name });
    api.connectApp({ appId }).then(
      (step) => handleStep(appId, name, step),
      (error: unknown) => {
        closePopup();
        setFlow({ kind: "error", appId, name, message: errorMessage(error) });
      },
    );
  }

  function retry() {
    if (flow) start(flow.appId, flow.name);
  }

  function cancel() {
    window.clearInterval(pollRef.current);
    closePopup();
    if (flowIdRef.current) {
      void api.cancelAppConnect(flowIdRef.current).catch(() => {});
      flowIdRef.current = null;
    }
    setFlow(null);
  }

  /** Returns an inline error message, or null once the flow has moved to its next step. */
  async function submitKey(values: Record<string, string>): Promise<string | null> {
    if (!flow || flow.kind !== "key") return null;
    const { appId, name } = flow;
    try {
      handleStep(appId, name, await api.connectApp({ appId, values }));
      return null;
    } catch (error) {
      return errorMessage(error);
    }
  }

  async function submitClient(clientId: string, clientSecret: string): Promise<string | null> {
    if (!flow || flow.kind !== "client") return null;
    const { appId, name } = flow;
    try {
      await api.saveAppOAuthClient({ appId, clientId, clientSecret });
      handleStep(appId, name, await api.connectApp({ appId }));
      return null;
    } catch (error) {
      return errorMessage(error);
    }
  }

  return { flow, start, retry, cancel, submitKey, submitClient };
}
