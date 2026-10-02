import type { AppCatalogItem, AppRule } from "@shared/types";

/** Short hint on a catalog card for how connecting works; null shows nothing (types "none"/"unknown"). */
export function connectHint(connect: AppCatalogItem["connect"]): string | null {
  switch (connect) {
    case "sign-in":
      return "Sign in";
    case "key":
      return "API key";
    case "client":
      return "Needs setup";
    default:
      return null;
  }
}

export const RULE_ACTION_LABELS: Record<AppRule["action"], string> = {
  approve: "Allowed",
  require_approval: "Ask me",
  block: "Blocked",
};

/** "users.messages.send" -> "Users messages send"; the whole-app rule ("*") reads as "All actions". */
export function humanizeAppTool(tool: string): string {
  if (tool === "*") return "All actions";
  const words = tool.replace(/[._-]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : tool;
}
