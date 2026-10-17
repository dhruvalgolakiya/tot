import { Fragment } from "react";
import clsx from "clsx";
import { mentionPieces } from "../../lib/files";

/** How a named file looks in text: a soft chip, without padding (in the composer it sits behind the textarea's own letters). */
export const FILE_CHIP = "rounded-[5px] bg-accent-soft shadow-[0_0_0_2px_var(--color-accent-soft)] [box-decoration-break:clone]";

/** Text with each named `@path` as an inline chip: a sent message's, or the composer's behind its textarea. */
export function MentionText({ text, files, transparent = false }: { text: string; files: string[]; transparent?: boolean }) {
  return mentionPieces(text, files).map((piece, index) =>
    piece.file ? (
      <span key={index} title={transparent ? undefined : piece.file} className={clsx(FILE_CHIP, transparent && "text-transparent")}>
        {piece.text}
      </span>
    ) : (
      <Fragment key={index}>{piece.text}</Fragment>
    ),
  );
}

/**
 * The composer's chips: a copy of its text laid exactly under the textarea (same box, font and wrapping), transparent
 * but for the chips' backgrounds, scrolled with it.
 */
export function MentionOverlay({ text, files, scrollTop, className }: { text: string; files: string[]; scrollTop: number; className: string }) {
  return (
    <div aria-hidden="true" className={clsx("pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap [overflow-wrap:break-word] text-transparent", className)}>
      <div style={{ transform: `translateY(${-scrollTop}px)` }}>
        <MentionText text={text} files={files} transparent />
        {/* A trailing newline needs a character after it to take up its line, as it does in the textarea. */}
        {"​"}
      </div>
    </div>
  );
}
