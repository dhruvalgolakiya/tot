import { useMemo, useState } from "react";
import clsx from "clsx";
import { ChevronRight } from "lucide-react";
import type { TaskChangedFile } from "@tot/shared/types";

const STATUS_LETTERS: Record<TaskChangedFile["status"], string> = { added: "A", modified: "M", deleted: "D", renamed: "R" };

/** The unified diff split per file, keyed by the file's (new) path. */
function splitPatch(patch: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const chunk of patch.split(/^(?=diff --git )/m)) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(chunk);
    if (header) files.set(header[2]!, chunk);
  }
  return files;
}

function lineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) return "text-fg-subtle";
  if (line.startsWith("@@")) return "text-fg-subtle bg-fill-subtle";
  if (line.startsWith("+")) return "bg-success-soft text-success";
  if (line.startsWith("-")) return "bg-danger-soft text-danger";
  return "text-fg-muted";
}

/** Changed files with +/− counts, each opening to its part of the unified diff. Read-only. */
export function ChangedFiles({ files, patch }: { files: TaskChangedFile[]; patch: string }) {
  const [openFile, setOpenFile] = useState<string | null>(null);
  const patches = useMemo(() => splitPatch(patch), [patch]);

  return (
    <ul className="divide-y divide-hairline overflow-hidden rounded-xl border border-hairline">
      {files.map((file) => {
        const expanded = openFile === file.path;
        const filePatch = patches.get(file.path);
        return (
          <li key={file.path}>
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() => setOpenFile(expanded ? null : file.path)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-hover focus-visible:-outline-offset-2"
            >
              <ChevronRight className={clsx("size-3.5 shrink-0 text-fg-subtle transition-transform", expanded && "rotate-90")} />
              <span className="w-3 shrink-0 font-mono text-xs text-fg-subtle" title={file.status}>
                {STATUS_LETTERS[file.status]}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-ui text-fg" title={file.path}>
                {file.path}
              </span>
              <span className="shrink-0 font-mono text-xs tabular-nums">
                <span className="text-success">+{file.additions}</span> <span className="text-danger">−{file.deletions}</span>
              </span>
            </button>
            {expanded && (
              <pre className="max-h-96 overflow-auto border-t border-hairline bg-sunken py-1 font-mono text-xs leading-relaxed">
                {/* As wide as the longest line, so added and removed lines stay shaded when scrolled sideways. */}
                <div className="inline-block min-w-full">
                  {(filePatch ?? "No diff to show (binary or too large).").split("\n").map((line, index) => (
                    <div key={index} className={clsx("px-3 whitespace-pre", lineClass(line))}>
                      {line || " "}
                    </div>
                  ))}
                </div>
              </pre>
            )}
          </li>
        );
      })}
    </ul>
  );
}
