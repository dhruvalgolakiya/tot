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
      className="inline-flex gap-1 rounded-xl bg-fill p-1"
    >
      {OPTIONS.map(({ value, label, Icon }) => (
        <RadioGroup.Item
          key={value}
          value={value}
          className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-ui font-medium text-fg-muted transition-colors hover:text-fg data-[state=checked]:bg-fg data-[state=checked]:text-canvas"
        >
          <Icon className="size-3.5" />
          {label}
        </RadioGroup.Item>
      ))}
    </RadioGroup.Root>
  );
}
