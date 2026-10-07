import { randomUUID } from "node:crypto";
import type { Routine, RoutineInput, RoutineSchedule } from "../../shared/types.ts";
import { db, parseJson, type Row } from "../db.ts";

const MIN_INTERVAL_MINUTES = 15;
const MAX_INTERVAL_MINUTES = 7 * 24 * 60;

function toRoutine(row: Row): Routine {
  return {
    id: String(row.id),
    agentId: String(row.agent_id),
    name: String(row.name),
    prompt: String(row.prompt),
    schedule: parseJson<RoutineSchedule>(row.schedule, { kind: "daily", time: "09:00" }),
    enabled: Boolean(row.enabled),
    lastRunAt: row.last_run_at == null ? null : Number(row.last_run_at),
    nextRunAt: row.next_run_at == null ? null : Number(row.next_run_at),
    lastConversationId: (row.last_conversation_id as string | null) ?? null,
    createdAt: Number(row.created_at),
    // Module 12: a project's schedule (it runs in the project's Lead: projects/schedules.ts).
    projectId: (row.project_id as string | null) ?? null,
  };
}

/** The first moment after `after` the schedule fires, in the server's local time. */
export function nextRun(schedule: RoutineSchedule, after = Date.now()): number {
  if (schedule.kind === "interval") return after + schedule.everyMinutes * 60_000;
  const [hours, minutes] = schedule.time.split(":").map(Number);
  const candidate = new Date(after);
  candidate.setSeconds(0, 0);
  candidate.setHours(hours, minutes);
  for (let day = 0; day <= 7; day++) {
    if (candidate.getTime() > after && (!schedule.days?.length || schedule.days.includes(candidate.getDay()))) {
      return candidate.getTime();
    }
    candidate.setDate(candidate.getDate() + 1);
    candidate.setHours(hours, minutes);
  }
  return after + 24 * 60 * 60_000;
}

export function validateRoutine(input: Partial<RoutineInput>, creating: boolean): string | null {
  if (creating || input.name !== undefined) {
    const name = input.name?.trim() ?? "";
    if (!name || name.length > 80) return "Routine names need 1–80 characters.";
  }
  if (creating || input.prompt !== undefined) {
    const prompt = input.prompt?.trim() ?? "";
    if (!prompt || prompt.length > 4000) return "Tell the agent what to do (up to 4000 characters).";
  }
  if (creating && !input.schedule) return "A routine needs a schedule.";
  const schedule = input.schedule;
  if (schedule) {
    if (schedule.kind === "interval") {
      const every = schedule.everyMinutes;
      if (!Number.isInteger(every) || every < MIN_INTERVAL_MINUTES || every > MAX_INTERVAL_MINUTES) {
        return `Intervals must be whole minutes between ${MIN_INTERVAL_MINUTES} and ${MAX_INTERVAL_MINUTES}.`;
      }
    } else if (schedule.kind === "daily") {
      const match = /^(\d{2}):(\d{2})$/.exec(schedule.time ?? "");
      if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) return 'Daily routines need a time like "08:30".';
      if (schedule.days && (!schedule.days.length || schedule.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6))) {
        return "Days must be 0 (Sunday) to 6 (Saturday).";
      }
    } else {
      return 'Schedule kind must be "daily" or "interval".';
    }
  }
  return null;
}

export const routines = {
  /** An agent's own routines (a project's schedules, run by its Lead, aren't in it), or every routine. */
  list(agentId?: string): Routine[] {
    const rows = (
      agentId
        ? db.prepare(`SELECT * FROM routines WHERE agent_id = ? AND project_id IS NULL ORDER BY created_at`).all(agentId)
        : db.prepare(`SELECT * FROM routines ORDER BY created_at`).all()
    ) as Row[];
    return rows.map(toRoutine);
  },

  /** Module 12: a project's schedules. */
  forProject(projectId: string): Routine[] {
    return (db.prepare(`SELECT * FROM routines WHERE project_id = ? ORDER BY created_at`).all(projectId) as Row[]).map(toRoutine);
  },

  get(id: string): Routine | null {
    const row = db.prepare(`SELECT * FROM routines WHERE id = ?`).get(id) as Row | undefined;
    return row ? toRoutine(row) : null;
  },

  create(agentId: string, input: RoutineInput): Routine {
    const id = randomUUID();
    const enabled = input.enabled ?? true;
    db.prepare(
      `INSERT INTO routines (id, agent_id, project_id, name, prompt, schedule, enabled, next_run_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      agentId,
      input.projectId ?? null,
      input.name.trim(),
      input.prompt.trim(),
      JSON.stringify(input.schedule),
      Number(enabled),
      enabled ? nextRun(input.schedule) : null,
      Date.now(),
    );
    return routines.get(id)!;
  },

  update(id: string, patch: Partial<RoutineInput>): Routine | null {
    const current = routines.get(id);
    if (!current) return null;
    const schedule = patch.schedule ?? current.schedule;
    const enabled = patch.enabled ?? current.enabled;
    // A new schedule, or switching on, starts counting from now.
    const reschedule = patch.schedule !== undefined || (patch.enabled === true && !current.enabled);
    db.prepare(`UPDATE routines SET name = ?, prompt = ?, schedule = ?, enabled = ?, next_run_at = ? WHERE id = ?`).run(
      patch.name?.trim() ?? current.name,
      patch.prompt?.trim() ?? current.prompt,
      JSON.stringify(schedule),
      Number(enabled),
      enabled ? (reschedule || current.nextRunAt === null ? nextRun(schedule) : current.nextRunAt) : null,
      id,
    );
    return routines.get(id);
  },

  delete(id: string): boolean {
    return db.prepare(`DELETE FROM routines WHERE id = ?`).run(id).changes > 0;
  },

  due(now = Date.now()): Routine[] {
    return (db.prepare(`SELECT * FROM routines WHERE enabled = 1 AND next_run_at <= ?`).all(now) as Row[]).map(toRoutine);
  },

  /** Module 12: moves the routine to its next time without counting a run (a project schedule's skipped slot keeps its last run's time). */
  skip(id: string, now = Date.now()): void {
    const routine = routines.get(id);
    if (!routine) return;
    db.prepare(`UPDATE routines SET next_run_at = ? WHERE id = ?`).run(routine.enabled ? nextRun(routine.schedule, now) : null, id);
  },

  /** Records a run (or a skipped slot) and moves the routine to its next time. */
  markRun(id: string, conversationId: string | null, now = Date.now()): void {
    const routine = routines.get(id);
    if (!routine) return;
    db.prepare(
      `UPDATE routines SET last_run_at = ?, last_conversation_id = COALESCE(?, last_conversation_id), next_run_at = ? WHERE id = ?`,
    ).run(now, conversationId, routine.enabled ? nextRun(routine.schedule, now) : null, id);
  },
};

/** "every weekday at 08:00" style description, used in tool output. */
export function describeSchedule(schedule: RoutineSchedule): string {
  if (schedule.kind === "interval") {
    const every = schedule.everyMinutes;
    return every % 60 === 0 ? `every ${every / 60 === 1 ? "hour" : `${every / 60} hours`}` : `every ${every} minutes`;
  }
  const names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const days = schedule.days?.length ? [...schedule.days].sort() : null;
  const when =
    !days || days.length === 7
      ? "every day"
      : days.join() === "1,2,3,4,5"
        ? "every weekday"
        : `every ${days.map((d) => names[d]).join(", ")}`;
  return `${when} at ${schedule.time}`;
}
