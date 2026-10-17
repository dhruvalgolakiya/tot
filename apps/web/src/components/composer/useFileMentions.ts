import { useEffect, useRef, useState } from "react";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { searchFiles, type FilesTarget } from "../../lib/files";

const NONE: string[] = [];

/**
 * The composer's "@" files: what matches the query being typed (asked of the server, which keeps the folder's list
 * for a while, so typing narrows it quickly), and the files picked so far. `root` is the folder's real path on this
 * Mac when it's here, for paths dragged in.
 */
export function useFileMentions(target: FilesTarget | null, query: string | null) {
  const key = target ? ("conversationId" in target ? `c:${target.conversationId}` : `p:${target.projectId}:${target.agentId ?? ""}`) : null;
  const [found, setFound] = useState<{ key: string; files: string[]; unavailable: string | null } | null>(null);
  const [named, setNamed] = useState<string[]>([]);
  const root = useRef<{ key: string; path: string | null } | null>(null);
  const asked = useDebouncedValue(query, 60);
  const targetRef = useRef(target);
  targetRef.current = target;

  useEffect(() => {
    const current = targetRef.current;
    if (!key || !current || asked === null) return;
    let live = true;
    searchFiles(current, asked).then(
      (result) => {
        root.current = { key, path: result.root };
        if (live) setFound({ key, files: result.files, unavailable: result.unavailable ?? null });
      },
      () => live && setFound({ key, files: [], unavailable: null }),
    );
    return () => {
      live = false;
    };
  }, [key, asked]);

  const shown = found && found.key === key && query !== null ? found : null;
  return {
    files: shown?.files ?? NONE,
    unavailable: shown && !shown.files.length ? shown.unavailable : null,
    named,
    name: (path: string) => setNamed((list) => (list.includes(path) ? list : [...list, path])),
    setNamed,
    /** The folder's path on this Mac, asked for once (a drag over the composer starts it, the drop uses it). */
    root: (): string | null | undefined => (root.current?.key === key ? root.current.path : undefined),
    loadRoot: () => {
      const current = targetRef.current;
      if (!key || !current || root.current?.key === key) return;
      root.current = { key, path: null };
      searchFiles(current, "").then((result) => (root.current = { key, path: result.root }), () => (root.current = null));
    },
  };
}
