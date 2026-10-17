import { useEffect, useRef } from "react";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { css } from "@codemirror/lang-css";
import { html } from "@codemirror/lang-html";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { python } from "@codemirror/lang-python";
import { bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { EditorState, type Extension } from "@codemirror/state";
import { drawSelection, EditorView, highlightActiveLine, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import { classHighlighter } from "@lezer/highlight";
import "./workspace.css";

/**
 * The Files tab's editor (CodeMirror 6, in a chunk of its own that loads the first time a file is edited): line
 * numbers, undo, search (⌘F), the theme's colors, and ⌘S to save. It keeps Escape to itself, so closing its
 * search box doesn't close the panel.
 */

function languageFor(path: string): Extension {
  const extension = path.split(".").pop()!.toLowerCase();
  if (["ts", "mts", "cts"].includes(extension)) return javascript({ typescript: true });
  if (extension === "tsx") return javascript({ typescript: true, jsx: true });
  if (["js", "mjs", "cjs"].includes(extension)) return javascript();
  if (extension === "jsx") return javascript({ jsx: true });
  if (["json", "jsonc"].includes(extension)) return json();
  if (["css", "scss"].includes(extension)) return css();
  if (["html", "htm", "svg", "xml", "vue", "svelte"].includes(extension)) return html();
  if (["md", "mdx", "markdown"].includes(extension)) return markdown();
  if (extension === "py") return python();
  return [];
}

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "12px", backgroundColor: "transparent", color: "var(--color-fg)" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "20px" },
  ".cm-content": { caretColor: "var(--color-fg)", padding: "4px 0" },
  ".cm-gutters": { backgroundColor: "transparent", color: "var(--color-fg-faint)", border: "none" },
  ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 12px" },
  ".cm-activeLine": { backgroundColor: "var(--color-fill-subtle)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--color-fg-muted)" },
  "&.cm-focused": { outline: "none" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--color-selected) !important" },
  ".cm-cursor": { borderLeftColor: "var(--color-fg)" },
  ".cm-selectionMatch": { backgroundColor: "var(--color-fill-strong)" },
  ".cm-matchingBracket": { backgroundColor: "var(--color-fill-strong)", outline: "none" },
  ".cm-panels": { backgroundColor: "var(--color-elevated)", color: "var(--color-fg)", borderColor: "var(--color-hairline)" },
  ".cm-panels input, .cm-panels button": { fontSize: "12px" },
});

export function CodeEditor({
  path,
  value,
  line,
  onChange,
  onSave,
}: {
  path: string;
  value: string;
  /** 1-based: put the cursor there and scroll to it when the editor opens. */
  line?: number;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const handlers = useRef({ onChange, onSave });
  handlers.current = { onChange, onSave };

  useEffect(() => {
    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightActiveLine(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          search({ top: true }),
          highlightSelectionMatches(),
          syntaxHighlighting(classHighlighter),
          languageFor(path),
          theme,
          keymap.of([
            { key: "Mod-s", preventDefault: true, run: () => (handlers.current.onSave(), true) },
            ...defaultKeymap,
            ...historyKeymap,
            ...searchKeymap,
            indentWithTab,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) handlers.current.onChange(update.state.doc.toString());
          }),
        ],
      }),
    });
    if (line && line <= view.state.doc.lines) {
      const at = view.state.doc.line(line).from;
      view.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: "center" }) });
    }
    view.focus();
    return () => view.destroy();
    // The editor is made once per file; later values come from it, not into it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  return <div ref={host} data-own-escape className="ws-code min-h-0 flex-1 overflow-hidden" />;
}
