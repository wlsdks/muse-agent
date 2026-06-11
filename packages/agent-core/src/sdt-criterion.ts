/**
 * Signal Detection Theory criterion for proactivity (Green & Swets 1966):
 * a notifier's SENSITIVITY and its DECISION THRESHOLD are independent —
 * notification fatigue is a mis-set criterion, not poor detection. The
 * optimal criterion is the likelihood ratio scaled by base rates and costs:
 * β = (P(noise)/P(signal)) · (C_falseAlarm/C_miss). A user who dismisses a
 * category earns it a higher firing floor; one who acts on it earns a lower
 * one — adaptation from the user's OWN response log, never a fixed constant.
 */

export interface NoticeResponseStats {
  readonly acted: number;
  readonly dismissed: number;
  /** Cost of an unwanted interruption (false alarm). Default 1. */
  readonly costFalseAlarm?: number;
  /** Cost of a missed useful nudge. Default 1. */
  readonly costMiss?: number;
}

const BETA_MIN = 0.25;
const BETA_MAX = 4;
/** Laplace prior so tiny histories can't swing the criterion to an extreme. */
const PRIOR = 1;

export function sdtCriterion(stats: NoticeResponseStats): number {
  const noise = Math.max(0, stats.dismissed) + PRIOR;
  const signal = Math.max(0, stats.acted) + PRIOR;
  const costRatio = (stats.costFalseAlarm ?? 1) / Math.max(1e-9, stats.costMiss ?? 1);
  const beta = (noise / signal) * costRatio;
  return Math.min(BETA_MAX, Math.max(BETA_MIN, beta));
}

/**
 * Map the criterion onto a confidence floor: β shrinks the ACCEPTANCE REGION
 * (1 − floor) proportionally — β=2 halves it, β=0.5 doubles it, β=1 is the
 * identity. Clamped to [0.05, 0.95] so adaptation can never fully silence a
 * category or open the floodgates.
 */
export function adjustConfidenceFloor(baseFloor: number, beta: number): number {
  const adjusted = 1 - (1 - baseFloor) / beta;
  return Math.min(0.95, Math.max(0.05, adjusted));
}

const ACTED_RE = /↩ user: (done|snooze)/u;
const DISMISS_RE = /↩ user: dismiss/u;

/** Per-kind response stats from proactive-history entries (done/snooze = acted; dismiss = noise). */
export function summarizeNoticeResponses(
  entries: ReadonlyArray<{ readonly kind: string; readonly text: string }>
): Map<string, { acted: number; dismissed: number }> {
  const stats = new Map<string, { acted: number; dismissed: number }>();
  for (const entry of entries) {
    const acted = ACTED_RE.test(entry.text);
    const dismissed = DISMISS_RE.test(entry.text);
    if (!acted && !dismissed) continue;
    const bucket = stats.get(entry.kind) ?? { acted: 0, dismissed: 0 };
    if (acted) bucket.acted += 1;
    if (dismissed) bucket.dismissed += 1;
    stats.set(entry.kind, bucket);
  }
  return stats;
}
