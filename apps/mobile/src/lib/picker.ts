import { router } from "expo-router";

/**
 * The model sheet (app/models.tsx) is a route, so it can be a native bottom sheet; what it's picking for (a chat,
 * a new chat's draft, an agent's default, Settings' default model) is handed over here instead of in the URL,
 * with the callback that takes the answer. One sheet is open at a time.
 */
export interface ModelRequest {
  title: string;
  /** The device whose models apply: a paired device's agent runs its chats there. */
  deviceId: string | null;
  current: string;
  onPick: (modelId: string) => void;
}

let pending: ModelRequest | null = null;

export function openModelPicker(request: ModelRequest) {
  pending = request;
  router.push("/models");
}

export function modelRequest(): ModelRequest | null {
  return pending;
}
