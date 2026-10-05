import { useEffect, useState } from "react";
import { LoaderCircle, MoonStar } from "lucide-react";
import type { MemoryRepoSummary } from "@shared/types";
import { api } from "../../lib/api";
import { relativeTime } from "../../lib/format";
import { notifyError, saveSettings, useStore } from "../../store";
import { SettingRow } from "../settings/SettingRow";
import { Button } from "../ui/Button";
import { cardClass } from "../ui/Card";
import { SectionHeader } from "../ui/SectionHeader";
import { Switch } from "../ui/Switch";

/**
 * Dreaming (roadmap module 10): the nightly tidy-up, for every memory repo: on/off and when (settings, applied
 * at once), and this repo's last dream with Undo, plus "Dream now".
 */
export function MemoryDreaming({ summary, onChanged }: { summary: MemoryRepoSummary; onChanged: () => void }) {
  const dreaming = useStore((s) => s.settings?.memory.dreaming);
  const [time, setTime] = useState(dreaming?.time ?? "03:30");
  const [starting, setStarting] = useState(false);
  useEffect(() => setTime(dreaming?.time ?? "03:30"), [dreaming?.time]);
  if (!dreaming) return null;

  const { dream } = summary;
  const busy = dream.running || starting;

  async function dreamNow() {
    setStarting(true);
    try {
      await api.dreamMemory(summary.id);
      onChanged();
    } catch (error) {
      notifyError(error);
    } finally {
      setStarting(false);
    }
  }

  async function undoDream(sha: string) {
    try {
      await api.revertMemory(summary.id, sha);
      onChanged();
    } catch (error) {
      notifyError(error);
    }
  }

  const saveTime = () => {
    if (/^([01]\d|2[0-3]):[0-5]\d$/.test(time) && time !== dreaming.time) void saveSettings({ memory: { dreaming: { time } } });
  };

  return (
    <section className="space-y-3">
      <SectionHeader
        title="Dreaming"
        description="While you sleep, TOT tidies memory: merges duplicates, drops stale entries, settles contradictions. Each night is one change you can undo."
      />
      <div className={cardClass({ padding: "none", className: "divide-y divide-hairline" })}>
        <SettingRow
          className="px-4"
          htmlFor="memory-dreaming"
          title="Dream every night"
          description="Only for memory that changed, or after chats, since the last dream. Uses your Claude or ChatGPT plan's light model."
          control={<Switch id="memory-dreaming" checked={dreaming.enabled} onCheckedChange={(enabled) => void saveSettings({ memory: { dreaming: { enabled } } })} />}
        />
        <SettingRow
          className="px-4"
          htmlFor="memory-dreaming-time"
          title="At"
          description="Local time on this device."
          control={
            <input
              id="memory-dreaming-time"
              type="time"
              value={time}
              disabled={!dreaming.enabled}
              onChange={(event) => setTime(event.target.value)}
              onBlur={saveTime}
              onKeyDown={(event) => event.key === "Enter" && saveTime()}
              className="input input-sm w-28 tabular-nums"
            />
          }
        />
        <SettingRow
          className="px-4"
          title={summary.kind === "you" ? "Last dream about you" : `Last dream about ${summary.name}`}
          description={
            busy ? (
              <span className="inline-flex items-center gap-1.5">
                <LoaderCircle className="size-3.5 animate-spin" /> Dreaming…
              </span>
            ) : dream.error ? (
              <span className="text-danger">{dream.error}</span>
            ) : dream.lastAt ? (
              <>
                {dream.summary} · {relativeTime(dream.lastAt)}
                {dream.sha && (
                  <>
                    {" · "}
                    <button type="button" className="link-muted" onClick={() => void undoDream(dream.sha!)}>
                      Undo
                    </button>
                  </>
                )}
              </>
            ) : (
              "Not yet."
            )
          }
          control={
            <Button size="sm" variant="secondary" disabled={busy} onClick={() => void dreamNow()}>
              <MoonStar /> {busy ? "Dreaming…" : "Dream now"}
            </Button>
          }
        />
      </div>
    </section>
  );
}
