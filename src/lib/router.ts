// No router library: "/a/:agentId" is an agent's new-chat home, "/c/:id" is
// an open conversation, "/mascots" is the mascot gallery (dev route), and
// "/" redirects to the first agent's home once agents are loaded.

export function agentPath(id: string): string {
  return `/a/${encodeURIComponent(id)}`;
}

export function agentIdFromPath(pathname: string): string | null {
  const match = /^\/a\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export function wikiPath(agentId: string, pageId?: string | null): string {
  const base = `/a/${encodeURIComponent(agentId)}/wiki`;
  return pageId ? `${base}/${encodeURIComponent(pageId)}` : base;
}

export function wikiFromPath(pathname: string): { agentId: string; pageId: string | null } | null {
  const match = /^\/a\/([^/]+)\/wiki(?:\/([^/]+))?\/?$/.exec(pathname);
  if (!match) return null;
  try {
    return { agentId: decodeURIComponent(match[1]), pageId: match[2] ? decodeURIComponent(match[2]) : null };
  } catch {
    return null;
  }
}

export function conversationPath(id: string): string {
  return `/c/${encodeURIComponent(id)}`;
}

export function conversationIdFromPath(pathname: string): string | null {
  const match = /^\/c\/([^/]+)\/?$/.exec(pathname);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

export const MASCOTS_PATH = "/mascots";

export type SettingsSection =
  | "general"
  | "models"
  | "memory"
  | "computer"
  | "github"
  | "apps"
  | "slack"
  | "personas"
  | "plugins";

const SETTINGS_SECTION_IDS: readonly SettingsSection[] = [
  "general",
  "models",
  "memory",
  "computer",
  "github",
  "apps",
  "slack",
  "personas",
  "plugins",
];

const SETTINGS_BASE_PATH = "/settings";

/** Omit `section` (or pass "general") for the bare "/settings" path. */
export function settingsPath(section?: SettingsSection): string {
  return section ? `${SETTINGS_BASE_PATH}/${section}` : SETTINGS_BASE_PATH;
}

export function isSettingsPath(pathname: string): boolean {
  return pathname === SETTINGS_BASE_PATH || pathname.startsWith(`${SETTINGS_BASE_PATH}/`);
}

/**
 * The section named in a settings URL. Null for the bare "/settings" path (no
 * section chosen yet — General on desktop, the section list on mobile).
 * Unknown section names fall back to "general". Only meaningful once
 * `isSettingsPath` is true.
 */
export function settingsSectionFromPath(pathname: string): SettingsSection | null {
  const match = /^\/settings(?:\/([^/]+))?\/?$/.exec(pathname);
  const section = match?.[1];
  if (!section) return null;
  return (SETTINGS_SECTION_IDS as string[]).includes(section) ? (section as SettingsSection) : "general";
}

export function pushPath(path: string) {
  if (window.location.pathname !== path) window.history.pushState(null, "", path);
}

export function replacePath(path: string) {
  if (window.location.pathname !== path) window.history.replaceState(null, "", path);
}
