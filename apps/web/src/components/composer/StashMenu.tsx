import { DropdownMenu } from "radix-ui";
import { Archive, X } from "lucide-react";
import { relativeTime } from "../../lib/format";
import { dropStashed, stashPreview, useStash, type StashedDraft } from "../../lib/stash";
import { Kbd } from "../ui/Kbd";
import { Tip } from "../ui/Tip";

/**
 * The composer's stashed drafts (⌘S puts one aside): a small count that opens the list. Enter or a click brings a draft
 * back (and takes it off the list), Delete or Backspace drops it.
 */
export function StashMenu({ onRestore }: { onRestore: (draft: StashedDraft) => void }) {
  const drafts = useStash((s) => s.drafts);
  if (drafts.length === 0) return null;

  return (
    <DropdownMenu.Root modal={false}>
      <Tip content="Stashed drafts">
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            aria-label={`${drafts.length} stashed draft${drafts.length === 1 ? "" : "s"}`}
            className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2 text-xs text-fg-muted tabular-nums transition-colors hover:bg-hover hover:text-fg data-[state=open]:bg-selected data-[state=open]:text-fg"
          >
            <Archive className="size-3.5" aria-hidden="true" />
            {drafts.length}
          </button>
        </DropdownMenu.Trigger>
      </Tip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content side="top" align="end" sideOffset={6} className="menu w-80 max-w-[calc(100vw-2rem)]">
          <DropdownMenu.Label className="menu-label">Stashed drafts</DropdownMenu.Label>
          <div className="max-h-72 overflow-y-auto">
            {drafts.map((draft) => (
              <DropdownMenu.Item
                key={draft.id}
                className="menu-item group/stash"
                onSelect={() => onRestore(draft)}
                onKeyDown={(event) => {
                  if (event.key !== "Delete" && event.key !== "Backspace") return;
                  event.preventDefault();
                  dropStashed(draft.id);
                }}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{stashPreview(draft)}</span>
                  <span className="block truncate text-xs text-fg-subtle">
                    {relativeTime(draft.savedAt)}
                    {draft.attachments.length ? ` · ${draft.attachments.length} file${draft.attachments.length === 1 ? "" : "s"}` : ""}
                  </span>
                </span>
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label="Delete draft"
                  onPointerDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    dropStashed(draft.id);
                  }}
                  className="grid size-6 shrink-0 place-items-center rounded-md text-fg-subtle opacity-0 transition-opacity group-hover/stash:opacity-100 group-data-[highlighted]/stash:opacity-100 hover:bg-hover hover:text-fg pointer-coarse:opacity-100"
                >
                  <X className="size-3.5" />
                </button>
              </DropdownMenu.Item>
            ))}
          </div>
          <p className="flex items-center gap-1.5 px-2 pt-1.5 pb-1 text-xs text-fg-subtle">
            <Kbd keys={["↵"]} /> restore <Kbd keys={["⌫"]} /> delete
            <span className="ml-auto flex items-center gap-1.5">
              <Kbd keys={["mod", "S"]} /> stash
            </span>
          </p>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
