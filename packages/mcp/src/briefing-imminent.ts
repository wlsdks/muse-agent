/**
 * Ground the situational briefing in the user's REAL imminent
 * personal tasks (P8-b3). Mirrors `runDueProactiveNotices`'s task
 * imminence selection exactly so the briefing's "Upcoming:" lines
 * agree with what the proactive daemon considers imminent:
 *   - status "open", a parseable `dueAt`, `proactive !== false`,
 *   - `dueAt` in `[now, now + leadMinutes]`.
 *
 * Pure + deterministic. The situational-briefing daemon calls this
 * per tick (imminence is time-relative); calendar-derived imminent
 * can be unioned in here later without touching the briefing
 * composer.
 */

import { readTasks } from "./personal-tasks-store.js";
import type { BriefingImminent } from "./situational-briefing.js";

const DEFAULT_LEAD_MINUTES = 120;

export async function deriveBriefingImminent(
  tasksFile: string,
  options: { readonly now: Date; readonly leadMinutes?: number }
): Promise<readonly BriefingImminent[]> {
  const lead = typeof options.leadMinutes === "number" && Number.isFinite(options.leadMinutes)
    ? options.leadMinutes
    : DEFAULT_LEAD_MINUTES;
  const nowMs = options.now.getTime();
  const cutoffMs = nowMs + lead * 60_000;

  let tasks: Awaited<ReturnType<typeof readTasks>>;
  try {
    tasks = await readTasks(tasksFile);
  } catch {
    return [];
  }

  const imminent: BriefingImminent[] = [];
  for (const task of tasks) {
    if (task.status !== "open") continue;
    if (!task.dueAt) continue;
    if (task.proactive === false) continue;
    const dueAt = new Date(task.dueAt);
    const dueMs = dueAt.getTime();
    if (Number.isNaN(dueMs)) continue;
    if (dueMs < nowMs || dueMs > cutoffMs) continue;
    imminent.push({ kind: "task", startsAt: dueAt, title: task.title });
  }
  return imminent;
}
