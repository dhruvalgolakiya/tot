import { useLayoutEffect, useRef, useState } from "react";
import type { WikiPage } from "@shared/types";
import { api, errorMessage } from "../../lib/api";
import { Button } from "../ui/Button";
import { Callout } from "../ui/Callout";
import { Field } from "../ui/Field";

type WikiPageEditorProps = {
  page: WikiPage;
  onSaved: (page: WikiPage) => void;
  onCancel: () => void;
};

/** Inline title/summary/content editor, in place of the rendered page. */
export function WikiPageEditor({ page, onSaved, onCancel }: WikiPageEditorProps) {
  const [title, setTitle] = useState(page.title);
  const [summary, setSummary] = useState(page.summary);
  const [content, setContent] = useState(page.content);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Let the markdown textarea grow with its content instead of scrolling internally.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [content]);

  async function save() {
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError("Give the page a title.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await api.updateWikiPage(page.id, { title: trimmedTitle, summary: summary.trim(), content });
      onSaved(updated);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <Field label="Title" htmlFor="wiki-edit-title">
        <input
          id="wiki-edit-title"
          autoFocus
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          className="input h-10 rounded-xl text-lg font-semibold"
        />
      </Field>
      <Field label="Summary" htmlFor="wiki-edit-summary" hint="One line: what's on the page, shown in the page list.">
        <input
          id="wiki-edit-summary"
          value={summary}
          onChange={(event) => setSummary(event.target.value)}
          className="input h-10 rounded-xl"
        />
      </Field>
      <Field label="Content" htmlFor="wiki-edit-content">
        <textarea
          id="wiki-edit-content"
          ref={textareaRef}
          rows={14}
          value={content}
          onChange={(event) => setContent(event.target.value)}
          placeholder="Markdown…"
          className="input min-h-[260px] resize-none rounded-xl font-mono text-ui leading-relaxed"
        />
      </Field>
      {error && <Callout tone="danger">{error}</Callout>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button variant="primary" onClick={() => void save()} disabled={saving}>
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}
