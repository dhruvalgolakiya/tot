import { Monitor, Moon, Sun, type LucideIcon } from "lucide-react";
import { RadioGroup } from "radix-ui";
import { setThemePreference, useThemePreference, type ThemePreference } from "../../lib/theme";

const OPTIONS: { value: ThemePreference; label: string; Icon: LucideIcon }[] = [
  { value: "system", label: "System", Icon: Monitor },
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
];

/** System / Light / Dark. Applies immediately and is saved on this device. */
export function ThemePicker() {
  const preference = useThemePreference();
  return (
    <RadioGroup.Root
      value={preference}
      onValueChange={(value) => setThemePreference(value as ThemePreference)}
      aria-label="Appearance"
      className="inline-flex gap-1 rounded-xl bg-white/[0.05] p-1"
    >
      {OPTIONS.map(({ value, label, Icon }) => (
        <RadioGroup.Item
          key={value}
          value={value}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium text-zinc-400 transition-colors outline-none hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-[var(--agent-accent-ring)] data-[state=checked]:bg-[var(--agent-accent-16)] data-[state=checked]:text-[var(--agent-accent-text)]"
        >
          <Icon className="size-3.5" />
          {label}
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}
