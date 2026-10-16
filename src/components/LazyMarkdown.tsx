import { lazy, Suspense, type ComponentProps } from "react";
import clsx from "clsx";
import { loadedMarkdown, loadMarkdown } from "../lib/markdownLoader";

const Markdown = lazy(() => loadMarkdown().then((module) => ({ default: module.Markdown })));

type LazyMarkdownProps = ComponentProps<typeof Markdown>;

/**
 * Markdown with a plain-text fallback while the renderer chunk loads. The fallback
 * stays invisible for its first half second (usually long enough for the chunk),
 * so raw markdown doesn't flash on screen. Once the chunk is here it renders
 * straight away, without a round through Suspense.
 */
export function LazyMarkdown(props: LazyMarkdownProps) {
  const loaded = loadedMarkdown();
  if (loaded) return <loaded.Markdown {...props} />;
  return (
    <Suspense
      fallback={
        <div
          className={clsx(
            "animate-[fade-in_200ms_ease-out_500ms_both] whitespace-pre-wrap [overflow-wrap:anywhere]",
            props.muted ? "text-sm text-fg-muted" : "text-chat text-fg",
          )}
        >
          {props.text}
        </div>
      }
    >
      <Markdown {...props} />
    </Suspense>
  );
}
