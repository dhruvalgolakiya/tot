import { isMac } from "../../lib/format";

/** Keyboard shortcut hint, e.g. keys={["mod", "shift", "O"]} → ⌘⇧O / Ctrl+Shift+O. */
export function Kbd({ keys }: { keys: string[] }) {
  const label = keys
    .map((key) => {
      if (key === "mod") return isMac ? "⌘" : "Ctrl";
      if (key === "shift") return isMac ? "⇧" : "Shift";
      return key;
    })
    .join(isMac ? "" : "+");
  return (
    <kbd className="rounded border border-white/10 bg-white/[0.04] px-1.5 py-px font-sans text-[11px] font-medium tracking-wide text-zinc-500">
      {label}
    </kbd>
  );
}
