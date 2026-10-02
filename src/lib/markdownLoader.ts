// The Markdown renderer (react-markdown + highlight.js + KaTeX) is most of the
// bundle, so it lives in its own chunk. Call this early to warm it up.
export const loadMarkdown = () => import("../components/Markdown");
