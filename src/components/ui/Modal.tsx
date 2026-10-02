import type { ReactNode } from "react";
import clsx from "clsx";
import { Dialog } from "radix-ui";
import { X } from "lucide-react";
import { IconButton } from "./IconButton";

type ModalProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  className?: string;
  children: ReactNode;
};

/** Centered dialog shell: overlay, title, optional description, close button. Esc closes. */
export function Modal({ open, onOpenChange, title, description, className, children }: ModalProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-scrim/75 backdrop-blur-md data-[state=closed]:animate-fade-out data-[state=open]:animate-fade-in" />
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6">
          <Dialog.Content
            {...(description ? {} : { "aria-describedby": undefined })}
            onEscapeKeyDown={(event) => {
              // Inline editors inside a dialog use Esc to cancel the edit, not to close the dialog.
              const focused = document.activeElement;
              if (focused instanceof HTMLElement && focused.closest("[data-escape-cancels]")) event.preventDefault();
            }}
            className={clsx(
              "surface-raised pointer-events-auto flex max-h-[min(88dvh,820px)] w-full flex-col overflow-hidden rounded-3xl border border-white/[0.08] outline-none data-[state=closed]:animate-pop-out data-[state=open]:animate-pop-in",
              className ?? "max-w-lg",
            )}
          >
            <div className="flex shrink-0 items-start gap-4 px-5 pt-5 pb-3">
              <div className="min-w-0 flex-1">
                <Dialog.Title className="text-base font-semibold tracking-[-0.02em] text-zinc-50">
                  {title}
                </Dialog.Title>
                {description && (
                  <Dialog.Description className="mt-1 text-sm leading-relaxed text-zinc-400">
                    {description}
                  </Dialog.Description>
                )}
              </div>
              <Dialog.Close asChild>
                <IconButton label="Close" size="sm" className="-mt-1 -mr-1.5">
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
