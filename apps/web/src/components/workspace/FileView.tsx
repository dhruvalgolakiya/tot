import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { toast } from "sonner";
import type { WorkspaceFile } from "@tot/shared/workspace";
import { ApiError, errorMessage } from "../../lib/api";
import { formatBytes } from "../../lib/format";
import { lazyComponent } from "../../lib/lazyComponent";
import { workspaceApi } from "../../lib/workspace";
import { LazyMarkdown } from "../LazyMarkdown";
import { Button } from "../ui/Button";
import { Callout } from "../ui/Callout";
import { EmptyState } from "../ui/EmptyState";
import { Skeleton } from "../ui/Skeleton";
import { highlightLines, languageFor } from "./highlight";
import { VirtualList } from "./VirtualList";

const CodeEditor = lazyComponent(() => import("./CodeEditor"), "CodeEditor");

const ROW = 20;
const MAX_CSV_ROWS = 2000;

/** Unsaved edits, by chat and file: kept while the tab, the panel or the chat is left, until saved or dropped. */
const drafts = new Map<string, { content: string; baseMtime: number }>();
const draftKey = (chatId: string, path: string) => `${chatId}\0${path}`;

export const hasDraft = (chatId: string, path: string) => drafts.has(draftKey(chatId, path));
export const dropDraft = (chatId: string, path: string) => drafts.delete(draftKey(chatId, path));

// Leaving the page with unsaved edits asks first.
window.addEventListener("beforeunload", (event) => {
  if (drafts.size) event.preventDefault();
});

/** Splits CSV (or TSV) into rows, quotes and all. */
function parseCsv(text: string, separator: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length && rows.length < MAX_CSV_ROWS; i++) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"' && !field) quoted = true;
    else if (char === separator) {
      row.push(field);
      field = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += char;
  }
  if (field || row.length) rows.push([...row, field]);
  return rows;
}

function CodePreview({ path, text, line }: { path: string; text: string; line?: number }) {
  const lines = useMemo(() => highlightLines(text.endsWith("\n") ? text.slice(0, -1) : text, languageFor(path)), [text, path]);
  const digits = String(lines.length).length;
  const widest = useMemo(() => text.split("\n").reduce((max, each) => Math.max(max, each.length), 0), [text]);
  const scrollTo = useMemo(() => (line ? { index: line - 1 } : null), [line]);
  return (
    <VirtualList
      label={path}
      count={lines.length}
      rowHeight={ROW}
      scrollTo={scrollTo}
      width={`calc(${widest + digits + 4}ch + 2rem)`}
      className="ws-code flex-1 py-1 text-xs"
      renderRow={(index) => (
        <div className={clsx("flex h-5 items-center leading-5 whitespace-pre", line === index + 1 && "bg-selected")}>
          <span className="shrink-0 pr-3 pl-3 text-right text-fg-faint tabular-nums select-none" style={{ width: `${digits + 4}ch` }}>
            {index + 1}
          </span>
          <span className="pr-4 text-fg" dangerouslySetInnerHTML={{ __html: lines[index]! }} />
        </div>
      )}
    />
  );
}

function CsvPreview({ text, separator }: { text: string; separator: string }) {
  const rows = useMemo(() => parseCsv(text, separator), [text, separator]);
  const [head, ...body] = rows;
  if (!head) return <EmptyState variant="quiet" title="This file is empty." className="m-2" />;
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <table className="min-w-full border-separate border-spacing-0 text-xs">
        <thead className="sticky top-0 bg-canvas">
          <tr>
            {head.map((cell, i) => (
              <th key={i} className="border-b border-hairline px-3 py-2 text-left font-medium whitespace-nowrap text-fg">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, r) => (
            <tr key={r} className="hover:bg-hover">
              {head.map((_, c) => (
                <td key={c} className="max-w-72 truncate border-b border-hairline px-3 py-1.5 text-fg-muted tabular-nums">
                  {row[c] ?? ""}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length >= MAX_CSV_ROWS && <p className="px-3 py-2 text-xs text-fg-subtle">The first {MAX_CSV_ROWS.toLocaleString()} rows are shown.</p>}
    </div>
  );
}

type Loaded = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; file: WorkspaceFile };

/**
 * One file of the chat's folder: code highlighted, markdown rendered, an image shown, a CSV as a table; a text
 * file can be edited and saved (⌘S) when this device may change the folder. An edit that isn't saved is kept
 * as a draft (see `drafts`); a save over a change made on disk since is refused, not lost.
 */
export function FileView({
  chatId,
  path,
  line,
  canWrite,
  version,
  onDraft,
}: {
  chatId: string;
  path: string;
  line?: number;
  canWrite: boolean;
  /** Changes when files in the folder may have changed: the file is read again unless it's being edited. */
  version: number;
  onDraft: () => void;
}) {
  const key = draftKey(chatId, path);
  const [state, setState] = useState<Loaded>({ status: "loading" });
  const [editing, setEditing] = useState(() => drafts.has(key));
  const [content, setContent] = useState<string | null>(() => drafts.get(key)?.content ?? null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<string | null>(null);
  /** Goes up when the editor's text is replaced from disk (it was open, unchanged, and the file changed). */
  const [revision, setRevision] = useState(0);

  const load = useCallback(async () => {
    try {
      const next = await workspaceApi.file(chatId, path);
      setState({ status: "ready", file: next });
      // Open in the editor with no edits yet: it shows the file as it is now.
      if (!drafts.has(key)) {
        setContent((current) => {
          if (current === null || current === next.content) return current;
          setRevision((value) => value + 1);
          return next.content ?? "";
        });
      }
    } catch (error) {
      setState({ status: "error", message: errorMessage(error) });
    }
  }, [chatId, path, key]);

  useEffect(() => {
    if (!drafts.has(key)) void load();
    else if (state.status === "loading") void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `version` asks for a fresh read.
  }, [load, version]);

  const file = state.status === "ready" ? state.file : null;
  const dirty = content !== null && file?.kind === "text" && content !== file.content;

  const change = (next: string) => {
    setContent(next);
    if (file && next !== file.content) drafts.set(key, { content: next, baseMtime: drafts.get(key)?.baseMtime ?? file.mtime });
    else drafts.delete(key);
    onDraft();
  };

  const save = async () => {
    if (!file || content === null || saving) return;
    setSaving(true);
    try {
      const saved = await workspaceApi.save(chatId, path, content, drafts.get(key)?.baseMtime ?? file.mtime);
      drafts.delete(key);
      onDraft();
      setConflict(null);
      setState({ status: "ready", file: { ...file, content, size: saved.size, mtime: saved.mtime } });
      toast.success("Saved");
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) setConflict(error.message);
      else toast.error(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    drafts.delete(key);
    onDraft();
    setContent(null);
    setEditing(false);
    setConflict(null);
    void load();
  };

  const extension = path.split(".").pop()!.toLowerCase();
  const kind = extension === "md" || extension === "mdx" || extension === "markdown" ? "markdown" : extension === "csv" || extension === "tsv" ? "table" : "code";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-hairline pr-2 pl-3">
        <span className="min-w-0 truncate font-mono text-ui text-fg" title={path}>
          {path}
        </span>
        {dirty && <span aria-label="Unsaved changes" className="size-1.5 shrink-0 rounded-full bg-fg-muted" />}
        <span className="ml-auto" />
        {file?.kind === "text" && canWrite && (
          editing ? (
            <>
              <Button size="sm" variant="ghost" onClick={dirty ? discard : () => setEditing(false)}>
                {dirty ? "Discard" : "Done"}
              </Button>
              <Button size="sm" variant="primary" disabled={!dirty || saving} onClick={() => void save()}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setContent(file.content ?? "");
                setEditing(true);
              }}
            >
              Edit
            </Button>
          )
        )}
      </div>
      {conflict && (
        <div className="shrink-0 border-b border-hairline p-2">
          <Callout tone="warning" action={<button type="button" className="link-muted" onClick={discard}>Reload</button>}>
            {conflict}
          </Callout>
        </div>
      )}
      {state.status === "loading" ? (
        <div className="space-y-1.5 p-3" aria-busy="true" aria-label="Loading the file">
          <Skeleton className="h-3.5 w-3/4" />
          <Skeleton className="h-3.5 w-1/2" />
          <Skeleton className="h-3.5 w-2/3" />
        </div>
      ) : state.status === "error" ? (
        <div className="p-3">
          <Callout tone="danger">{state.message}</Callout>
        </div>
      ) : state.file.kind === "image" ? (
        <div className="grid min-h-0 flex-1 place-items-center overflow-auto bg-fill-subtle p-4">
          <img src={workspaceApi.rawUrl(chatId, path, state.file.mtime)} alt={path} className="max-h-full max-w-full object-contain" />
        </div>
      ) : state.file.kind === "binary" ? (
        <EmptyState size="sm" title="A binary file" description={`${formatBytes(state.file.size)}; it can't be shown here.`} />
      ) : state.file.kind === "too-large" ? (
        <EmptyState size="sm" title="Too large to show" description={`${formatBytes(state.file.size)}; open it in your editor.`} />
      ) : editing && content !== null ? (
        <Suspense fallback={<div className="p-3"><Skeleton className="h-3.5 w-1/2" /></div>}>
          <CodeEditor key={`${path}:${revision}`} path={path} value={content} line={line} onChange={change} onSave={() => void save()} />
        </Suspense>
      ) : kind === "markdown" ? (
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <LazyMarkdown text={state.file.content ?? ""} />
        </div>
      ) : kind === "table" ? (
        <CsvPreview text={state.file.content ?? ""} separator={extension === "tsv" ? "\t" : ","} />
      ) : (
        <CodePreview path={path} text={state.file.content ?? ""} line={line} />
      )}
    </div>
  );
}
