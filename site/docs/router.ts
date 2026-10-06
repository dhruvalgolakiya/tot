import { useSyncExternalStore, type MouseEvent } from "react";

/** The docs live under /docs; each page has its own URL (/docs/agents), served by one HTML file. */
export const BASE = "/docs";

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
window.addEventListener("popstate", notify);

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** The page slug from the address bar: "" for the docs home, "agents" for /docs/agents. */
function currentSlug(): string {
  const path = location.pathname.replace(/\/+$/, "");
  if (path === BASE || !path.startsWith(`${BASE}/`)) return "";
  return decodeURIComponent(path.slice(BASE.length + 1));
}

export const useSlug = () => useSyncExternalStore(subscribe, currentSlug);
export const useHash = () => useSyncExternalStore(subscribe, () => decodeURIComponent(location.hash.slice(1)));

export const hrefFor = (slug: string, hash?: string) => `${slug ? `${BASE}/${slug}` : BASE}${hash ? `#${hash}` : ""}`;

/** Goes to a docs URL without reloading: scrolls to its heading when it has a #hash, or to the top. */
export function navigate(href: string) {
  const url = new URL(href, location.href);
  const samePage = url.pathname === location.pathname;
  if (url.href !== location.href) history.pushState(null, "", url.pathname + url.search + url.hash);
  notify();
  requestAnimationFrame(() => {
    const target = url.hash ? document.getElementById(decodeURIComponent(url.hash.slice(1))) : null;
    if (target) target.scrollIntoView({ behavior: samePage ? "smooth" : "auto", block: "start" });
    else if (!samePage) window.scrollTo({ top: 0 });
  });
}

/** True for links the docs handle themselves (same site, under /docs, no modifier keys, no new tab). */
export function isDocsLink(href: string | undefined): href is string {
  if (!href) return false;
  if (href.startsWith("#")) return true;
  try {
    const url = new URL(href, location.href);
    return url.origin === location.origin && (url.pathname === BASE || url.pathname.startsWith(`${BASE}/`));
  } catch {
    return false;
  }
}

export function onDocsLinkClick(event: MouseEvent<HTMLAnchorElement>, href: string, after?: () => void) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(href);
  after?.();
}
