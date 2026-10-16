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
    <kbd className="inline-flex h-5 min-w-5 items-center justify-center rounded-md border border-edge bg-fill-subtle px-1 font-sans text-2xs font-medium tracking-wide text-fg-subtle tabular-nums">
      {label}
    </kbd>
  );
}
