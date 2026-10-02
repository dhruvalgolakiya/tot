import clsx from "clsx";
import type { WikiHeading } from "../../lib/wiki";

type WikiOutlineProps = {
  headings: WikiHeading[];
  onSelect: (headingText: string) => void;
};

/** Optional "On this page" h2/h3 outline, shown only on very wide screens. */
export function WikiOutline({ headings, onSelect }: WikiOutlineProps) {
  if (headings.length === 0) return null;
  return (
    <nav aria-label="On this page" className="w-56 shrink-0 overflow-y-auto border-l border-white/[0.06] px-4 py-6">
      <p className="label-caps mb-2 px-1">On this page</p>
      <ul className="space-y-0.5">
        {headings.map((heading, index) => (
          <li key={index}>
            <button
              type="button"
              onClick={() => onSelect(heading.text)}
              className={clsx(
                "block w-full truncate rounded-md px-2 py-1 text-left text-xs text-zinc-500 transition-colors hover:text-zinc-200",
                heading.level === 3 && "pl-4",
              )}
            >
              {heading.text}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}
