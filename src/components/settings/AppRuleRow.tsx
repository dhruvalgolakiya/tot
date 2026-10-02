import { useState } from "react";
import clsx from "clsx";
import { DropdownMenu } from "radix-ui";
import { Check, ChevronDown } from "lucide-react";
import type { AppRule } from "@shared/types";
import { api } from "../../lib/api";
import { humanizeAppTool, RULE_ACTION_LABELS } from "../../lib/apps";
import { notifyError } from "../../store";

type AppRuleRowProps = {
  rule: AppRule;
  appId: string;
  onChanged: (rules: AppRule[]) => void;
};

const ACTIONS: AppRule["action"][] = ["approve", "require_approval", "block"];

/** One row: the whole app ("All actions") or a single action, with a segmented-select for its rule. */
export function AppRuleRow({ rule, appId, onChanged }: AppRuleRowProps) {
  const [saving, setSaving] = useState(false);

  async function setAction(action: AppRule["action"] | "default") {
    setSaving(true);
    try {
      onChanged(await api.setAppRule(appId, { tool: rule.tool, action }));
    } catch (error) {
      notifyError(error);
    } finally {
      setSaving(false);
    }
  }

  return (
    <li className="flex items-center gap-3 px-3.5 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-zinc-200">{humanizeAppTool(rule.tool)}</p>
        {rule.description && <p className="mt-0.5 truncate text-xs text-zinc-500">{rule.description}</p>}
      </div>
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            disabled={saving}
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-white/[0.07] disabled:opacity-50"
          >
            <span className={clsx(rule.isDefault ? "text-zinc-500" : "text-zinc-200")}>{RULE_ACTION_LABELS[rule.action]}</span>
            {rule.isDefault && <span className="rounded bg-white/[0.08] px-1 py-px text-[10px] font-normal text-zinc-500">default</span>}
            <ChevronDown className="size-3.5 text-zinc-500" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={4} className="menu w-40">
            <DropdownMenu.RadioGroup value={rule.action} onValueChange={(value) => void setAction(value as AppRule["action"])}>
              {ACTIONS.map((action) => (
                <DropdownMenu.RadioItem key={action} value={action} className="menu-item justify-between">
                  {RULE_ACTION_LABELS[action]}
                  <DropdownMenu.ItemIndicator>
                    <Check className="size-3.5 text-zinc-100" />
                  </DropdownMenu.ItemIndicator>
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
            {!rule.isDefault && (
              <>
                <DropdownMenu.Separator className="menu-separator" />
                <DropdownMenu.Item className="menu-item" onSelect={() => void setAction("default")}>
                  Reset to default
                </DropdownMenu.Item>
              </>
            )}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </li>
  );
}
