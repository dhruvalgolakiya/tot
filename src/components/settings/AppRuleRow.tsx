import { useState } from "react";
import { DropdownMenu } from "radix-ui";
import { Check, ChevronDown } from "lucide-react";
import type { AppRule } from "@shared/types";
import { api } from "../../lib/api";
import { humanizeAppTool, RULE_ACTION_LABELS } from "../../lib/apps";
import { notifyError } from "../../store";
import { Chip } from "../ui/Chip";
import { ledgerRowClass } from "../ui/Ledger";

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
    <div className={ledgerRowClass({ className: "justify-between gap-3" })}>
      <div className="min-w-0 flex-1">
        <p className="truncate text-ui text-fg">{humanizeAppTool(rule.tool)}</p>
        {rule.description && <p className="truncate text-xs text-fg-subtle">{rule.description}</p>}
      </div>
      <DropdownMenu.Root modal={false}>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            disabled={saving}
            className="flex shrink-0 items-center gap-1.5 rounded-lg border border-edge bg-fill-subtle px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-hover disabled:opacity-50"
          >
            <span className={rule.isDefault ? "text-fg-subtle" : "text-fg"}>{RULE_ACTION_LABELS[rule.action]}</span>
            {rule.isDefault && <Chip tone="neutral">default</Chip>}
            <ChevronDown className="size-3.5 text-fg-subtle" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={4} className="menu w-40">
            <DropdownMenu.RadioGroup value={rule.action} onValueChange={(value) => void setAction(value as AppRule["action"])}>
              {ACTIONS.map((action) => (
                <DropdownMenu.RadioItem key={action} value={action} className="menu-item justify-between">
                  {RULE_ACTION_LABELS[action]}
                  <DropdownMenu.ItemIndicator>
                    <Check className="size-3.5 text-fg" />
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
    </div>
  );
}
