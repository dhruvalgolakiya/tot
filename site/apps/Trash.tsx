import { useState } from "react";
import { FileText, Image, Package, Trash2 } from "lucide-react";
import type { LucideIcon } from "lucide-react";

const ITEMS: { icon: LucideIcon; name: string; why: string }[] = [
  { icon: FileText, name: "API_KEYS.txt", why: "Not needed. You log in with the plans you already have." },
  { icon: Image, name: "loading-spinner.gif", why: "Replaced by a frog in sunglasses." },
  { icon: Package, name: "merge-button.app", why: "Thrown out on purpose. Merging is your job." },
  { icon: FileText, name: "long-answers.docx", why: "You said you hate these. Noted, in memory." },
  { icon: FileText, name: "did-it-finish.txt", why: "Chats wake up on their own now." },
  { icon: FileText, name: "push-to-main.sh", why: "Never ran. Never will." },
];

/** An easter egg: what TOT threw away. */
export function Trash() {
  const [tried, setTried] = useState(false);
  return (
    <div className="flex min-h-full flex-col">
      <ul className="flex-1 divide-y divide-hairline px-2 py-2">
        {ITEMS.map(({ icon: Icon, name, why }) => (
          <li key={name} className="flex items-start gap-3 px-3 py-3">
            <Icon className="mt-0.5 size-4.5 shrink-0 text-fg-subtle" />
            <div className="min-w-0">
              <p className="font-mono text-ui text-fg">{name}</p>
              <p className="mt-0.5 text-ui text-fg-muted">{why}</p>
            </div>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-3 border-t border-hairline px-5 py-3">
        <p className="min-w-0 flex-1 text-xs text-fg-subtle" aria-live="polite">
          {tried ? "Nice try. Some things belong in the trash forever." : `${ITEMS.length} items`}
        </p>
        <button
          type="button"
          onClick={() => setTried(true)}
          className="inline-flex h-8 items-center gap-1.5 rounded-full border border-edge px-3.5 text-ui font-medium text-fg transition-colors hover:bg-hover"
        >
          <Trash2 className="size-3.5" /> Empty Trash
        </button>
      </div>
    </div>
  );
}
