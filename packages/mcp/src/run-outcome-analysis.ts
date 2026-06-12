import { topicKeyFromMessage } from "./weakness-ledger.js";

/**
 * Run-log outcome analysis — the failure-RATE the cumulative weakness ledger
 * lacks. The ledger counts how many times each topic failed, but not the
 * DENOMINATOR (failures out of how many runs), so it can't tell "improving" from
 * "more usage". Each `.muse/runs/<runId>.jsonl` line carries a top-level
 * `grounded` outcome label (grounded | abstain | ungrounded | null); this tallies
 * them into a rate + the top failing topics. Pure (no I/O) — the caller reads the
 * run-logs and passes the parsed entries.
 */

export interface RunOutcomeEntry {
  /** The outcome label lifted to the run-log top level. `null` = verdict never ran (json/vision skip). */
  readonly grounded: string | null;
  readonly message: string;
}

export interface RunOutcomeTopic {
  readonly topic: string;
  readonly count: number;
}

export interface RunOutcomeSummary {
  /** Runs that carried a real outcome label (null/skip excluded — they're not measurable). */
  readonly labelled: number;
  readonly grounded: number;
  readonly abstain: number;
  readonly ungrounded: number;
  /** (abstain + ungrounded) / labelled — 0 when nothing labelled. Lower is better. */
  readonly failRate: number;
  /** The recurring topics behind the failing runs, busiest first. */
  readonly topFailingTopics: readonly RunOutcomeTopic[];
}

const DEFAULT_MAX_TOPICS = 5;

export function analyzeRunOutcomes(
  entries: readonly RunOutcomeEntry[],
  options?: { readonly maxTopics?: number }
): RunOutcomeSummary {
  const maxTopics = Number.isFinite(options?.maxTopics) ? Math.max(1, Math.trunc(options!.maxTopics!)) : DEFAULT_MAX_TOPICS;
  let labelled = 0;
  let grounded = 0;
  let abstain = 0;
  let ungrounded = 0;
  const failingTopics = new Map<string, number>();
  for (const entry of entries) {
    const label = entry.grounded;
    if (label === "grounded") {
      grounded += 1;
      labelled += 1;
    } else if (label === "abstain") {
      abstain += 1;
      labelled += 1;
    } else if (label === "ungrounded") {
      ungrounded += 1;
      labelled += 1;
    } else {
      continue; // null / unknown label — verdict never ran, not measurable
    }
    if (label === "abstain" || label === "ungrounded") {
      const topic = topicKeyFromMessage(entry.message);
      if (topic.length > 0) {
        failingTopics.set(topic, (failingTopics.get(topic) ?? 0) + 1);
      }
    }
  }
  const failures = abstain + ungrounded;
  const topFailingTopics = [...failingTopics.entries()]
    .map(([topic, count]) => ({ count, topic }))
    .sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic))
    .slice(0, maxTopics);
  return {
    abstain,
    failRate: labelled === 0 ? 0 : failures / labelled,
    grounded,
    labelled,
    topFailingTopics,
    ungrounded
  };
}
