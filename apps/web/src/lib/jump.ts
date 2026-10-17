import { navigateToConversation } from "../store";

/** How long to keep looking for the message (the chat loading, its older rows rendering) before giving up. */
const GIVE_UP_MS = 6000;
/** How long the found message stays marked, and its matched words highlighted. */
const MARK_MS = 2400;
const HIGHLIGHT = "tot-search";

let pending = 0;

/**
 * Open a chat at one of its messages (a search hit): the message scrolls into the middle of the view and is marked for
 * a moment, with the words that matched highlighted in it.
 */
export function jumpToMessage(conversationId: string, messageId: string, words: string[]): void {
  navigateToConversation(conversationId);
  const run = ++pending;
  const started = performance.now();
  const selector = `[data-message-id="${CSS.escape(messageId)}"]`;
  const look = () => {
    if (run !== pending) return;
    const row = [...document.querySelectorAll<HTMLElement>(selector)].find((el) => el.offsetParent !== null);
    if (row) return reveal(row, words);
    if (performance.now() - started > GIVE_UP_MS) return;
    // Older rows render once the list is scrolled up to them.
    const list = [...document.querySelectorAll<HTMLElement>("[data-message-list]")].find((el) => el.offsetParent !== null);
    if (list?.querySelector("[data-message-id]")) list.scrollTop = 0;
    window.setTimeout(look, 80);
  };
  requestAnimationFrame(look);
}

function reveal(row: HTMLElement, words: string[]): void {
  row.scrollIntoView({ block: "center" });
  row.dataset.jumped = "";
  window.setTimeout(() => delete row.dataset.jumped, MARK_MS);
  highlightWords(row, words);
}

/** Highlights `words` inside `root` without changing its DOM (the CSS Custom Highlight API, where there is one). */
function highlightWords(root: HTMLElement, words: string[]): void {
  const registry = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  const HighlightClass = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  if (!registry || !HighlightClass || !words.length) return;
  const ranges: Range[] = [];
  const pattern = new RegExp(words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "giu");
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? "";
    for (const match of text.matchAll(pattern)) {
      const range = new Range();
      range.setStart(node, match.index);
      range.setEnd(node, match.index + match[0].length);
      ranges.push(range);
    }
  }
  const highlight = new HighlightClass(...ranges);
  registry.set(HIGHLIGHT, highlight);
  window.setTimeout(() => registry.get(HIGHLIGHT) === highlight && registry.delete(HIGHLIGHT), MARK_MS * 2);
}
