import { Switch as RadixSwitch } from "radix-ui";

type SwitchProps = {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  label?: string;
};

export function Switch({ checked, onCheckedChange, disabled, id, label }: SwitchProps) {
  return (
    <RadixSwitch.Root
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={label}
      className="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full bg-zinc-700 transition-colors duration-150 hover:bg-zinc-600 disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-accent data-[state=checked]:hover:bg-accent/90"
    >
      <RadixSwitch.Thumb className="block size-4 translate-x-0.5 rounded-full bg-fixed-white shadow-sm shadow-shade/30 transition-transform duration-200 ease-emphasized data-[state=checked]:translate-x-[18px]" />
    </RadixSwitch.Root>
  );
}
