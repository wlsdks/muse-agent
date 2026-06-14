/**
 * Stale-task + episode-revisit selection and formatting for `muse today`.
 * Pure helpers (no I/O) split out of commands-today.ts.
 */

import { revisitDueInterval } from "./commands-notes-rag.js";

const STALE_TASK_DAYS = 14;
const STALE_TASK_MAX = 5;

export interface StaleTask {
  readonly id: string;
  readonly title: string;
  readonly ageDays: number;
}

/**
 * Open + UNDATED tasks older than `thresholdDays` (by createdAt), oldest
 * first, capped — a GTD review nudge (Allen 2001, "Getting Things Done")
 * for "stuff" that silently rots. DATED tasks are excluded: today's
 * imminent view already surfaces those, so this is complementary, not a
 * double-listing. Unparseable createdAt is skipped.
 */
export function selectStaleTasks(
  tasks: readonly { readonly id: string; readonly title: string; readonly status: string; readonly createdAt: string; readonly dueAt?: string }[],
  nowMs: number,
  thresholdDays: number = STALE_TASK_DAYS
): StaleTask[] {
  const threshold = Number.isFinite(thresholdDays) && thresholdDays > 0 ? thresholdDays : STALE_TASK_DAYS;
  return tasks
    .flatMap((task) => {
      if (task.status !== "open" || task.dueAt !== undefined) {
        return [];
      }
      const created = Date.parse(task.createdAt);
      if (!Number.isFinite(created)) {
        return [];
      }
      const ageDays = (nowMs - created) / 86_400_000;
      return ageDays >= threshold ? [{ ageDays, id: task.id, title: task.title }] : [];
    })
    .sort((a, b) => b.ageDays - a.ageDays)
    .slice(0, STALE_TASK_MAX);
}

export interface DueEpisode {
  readonly summary: string;
  readonly intervalDays: number;
  readonly ageDays: number;
}

/**
 * The single most evocative past session due for a spaced revisit today —
 * an episode whose age (by endedAt) crossed a review interval, the
 * "remember when" half of the spacing effect applied to conversations
 * (the same schedule notes use). Picks the largest interval crossed
 * (oldest memory), most-recent endedAt as the tiebreak. Undefined when
 * none is due. Unparseable endedAt is skipped.
 */
export function selectEpisodeToRevisit(
  episodes: readonly { readonly summary: string; readonly endedAt: string }[],
  nowMs: number
): DueEpisode | undefined {
  const due = episodes.flatMap((ep) => {
    const ended = Date.parse(ep.endedAt);
    if (!Number.isFinite(ended)) {
      return [];
    }
    const ageDays = (nowMs - ended) / 86_400_000;
    const intervalDays = revisitDueInterval(ageDays);
    return intervalDays === undefined ? [] : [{ ageDays, intervalDays, summary: ep.summary }];
  });
  due.sort((a, b) => b.intervalDays - a.intervalDays || a.ageDays - b.ageDays);
  return due[0];
}

/** Render the one-line "💭 N days ago" past-session resurface (empty when none). */
export function formatEpisodeRevisitLine(episode: DueEpisode | undefined): string {
  if (!episode) {
    return "";
  }
  const oneLine = episode.summary.replace(/\s+/gu, " ").trim().slice(0, 100);
  const days = Math.floor(episode.ageDays);
  return `\n💭 ${days.toString()} day${days === 1 ? "" : "s"} ago: ${oneLine}\n`;
}

/** Render the proactive "Open a while — still relevant?" nudge (empty when none). */
export function formatStaleTasksSection(stale: readonly StaleTask[]): string {
  if (stale.length === 0) {
    return "";
  }
  const lines = stale.map((task) => `  [${Math.floor(task.ageDays).toString()}d] ${task.title}`);
  return `\n🗂 Open a while — still relevant?\n${lines.join("\n")}\n`;
}
