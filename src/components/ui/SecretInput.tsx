import { useState } from "react";
import { CircleCheck, Eye, EyeOff } from "lucide-react";

type SecretInputProps = {
  id: string;
  value: string;
  /** Typing a new key should also cancel a pending "remove". */
  onChange: (value: string) => void;
  /** A key is already stored on the server (it is never sent back). */
  saved: boolean;
  /** The user asked to remove the stored key on save. */
  cleared: boolean;
  onClearedChange: (cleared: boolean) => void;
  placeholder: string;
};

/** Write-only secret field: shows "Key saved" instead of the value. */
export function SecretInput({ id, value, onChange, saved, cleared, onClearedChange, placeholder }: SecretInputProps) {
  const [visible, setVisible] = useState(false);
  const showSaved = saved && !cleared && !value;

  return (
    <div className="space-y-2">
      <div className="relative">
        <input
          id={id}
          type={visible ? "text" : "password"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={saved && !cleared ? "Enter a new key to replace the saved one" : placeholder}
          autoComplete="off"
          spellCheck={false}
          className="input pr-10 font-mono"
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? "Hide key" : "Show key"}
          className="absolute inset-y-0 right-0 grid w-10 place-items-center text-zinc-500 hover:text-zinc-200"
        >
          {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      </div>
      {showSaved && (
        <p className="flex items-center gap-1.5 text-xs text-emerald-400">
          <CircleCheck className="size-3.5" />
          Key saved
          <button
            type="button"
            onClick={() => onClearedChange(true)}
            className="ml-1 text-zinc-500 underline-offset-2 hover:text-zinc-300 hover:underline"
          >
            Remove
          </button>
        </p>
      )}
      {saved && cleared && !value && (
        <p className="flex items-center gap-1.5 text-xs text-amber-300">
          The saved key will be removed when you save.
          <button
            type="button"
            onClick={() => onClearedChange(false)}
            className="text-zinc-400 underline-offset-2 hover:text-zinc-200 hover:underline"
          >
            Undo
          </button>
        </p>
      )}
    </div>
  );
}
