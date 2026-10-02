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
          className="absolute inset-y-0 right-0 grid w-10 place-items-center rounded-r-lg text-fg-subtle transition-colors hover:text-fg focus-visible:-outline-offset-2"
        >
          {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      </div>
      {showSaved && (
        <p className="flex items-center gap-1.5 text-xs text-success">
          <CircleCheck className="size-3.5" />
          Key saved
          <button
            type="button"
            onClick={() => onClearedChange(true)}
            className="link-muted ml-1"
          >
            Remove
          </button>
        </p>
      )}
      {saved && cleared && !value && (
        <p className="flex items-center gap-1.5 text-xs text-warning">
          The saved key will be removed when you save.
          <button
            type="button"
            onClick={() => onClearedChange(false)}
            className="link-muted"
          >
            Undo
          </button>
        </p>
      )}
    </div>
  );
}
