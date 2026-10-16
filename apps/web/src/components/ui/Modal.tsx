import type { ComponentProps, ReactNode } from "react";
import clsx from "clsx";
import { Dialog } from "radix-ui";
import { X } from "lucide-react";
import { IconButton } from "./IconButton";

type ModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  /** Width (default `max-w-lg`) plus any layout classes, e.g. `flex max-w-md`. */
  className?: string;
  children: ReactNode;
};

/**
 * Centered dialog shell: overlay, title, optional description, close button. Esc closes.
 * Lay out the content with <ModalBody> and <ModalFooter> (both use the header's 20px gutter).
 */
export function Modal({ open, onOpenChange, title, description, className, children }: ModalProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-scrim/60 backdrop-blur-[2px] data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in" />
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6">
          <Dialog.Content
            {...(description ? {} : { "aria-describedby": undefined })}
            onEscapeKeyDown={(event) => {
              // Inline editors inside a dialog use Esc to cancel the edit, not to close the dialog.
              const focused = document.activeElement;
              if (focused instanceof HTMLElement && focused.closest("[data-escape-cancels]")) event.preventDefault();
            }}
            className={clsx(
              "pointer-events-auto flex max-h-[min(88dvh,820px)] w-full flex-col overflow-hidden rounded-2xl border border-hairline bg-elevated shadow-dialog outline-none data-[state=closed]:animate-pop-out data-[state=open]:animate-pop-in",
              className ?? "max-w-lg",
            )}
          >
            <div className="flex shrink-0 items-start gap-4 px-6 pt-6 pb-4">
              <div className="min-w-0 flex-1">
                <Dialog.Title className="text-lg font-semibold text-fg-strong">{title}</Dialog.Title>
                {description && (
                  <Dialog.Description className="mt-1 text-sm leading-relaxed text-fg-muted">
                    {description}
                  </Dialog.Description>
                )}
              </div>
              <Dialog.Close asChild>
                <IconButton label="Close" size="sm" className="-mt-1.5 -mr-2">
                  <X />
                </IconButton>
              </Dialog.Close>
            </div>
            {children}
          </Dialog.Content>
        </div>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Scrollable dialog content with the standard gutter. */
export function ModalBody({ className, ...props }: ComponentProps<"div">) {
  return <div className={clsx("min-h-0 flex-1 overflow-y-auto px-6 pt-1 pb-6", className)} {...props} />;
}

type ModalFooterProps = ComponentProps<"div"> & {
  /** A hairline above the actions. On by default; turn off for short confirm dialogs. */
  divider?: boolean;
};

/** Right-aligned dialog actions: secondary/ghost first, the one primary last. */
export function ModalFooter({ divider = true, className, ...props }: ModalFooterProps) {
  return (
    <div
      className={clsx(
        "flex shrink-0 items-center justify-end gap-2 px-6",
        divider ? "border-t border-hairline py-4" : "pt-2 pb-6",
        className,
      )}
      {...props}
    />
  );
}
