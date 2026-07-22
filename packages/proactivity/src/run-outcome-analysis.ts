import { topicKeyFromMessage } from "@muse/stores";
import {
  CANONICAL_RUN_OUTCOMES,
  RUN_GROUNDING_FRESHNESS_MS,
  admitDecisionMetric,
  isCanonicalLocalRunId,
  type DecisionMetric,
  type DecisionMetricExclusionReason
} from "@muse/shared";

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
  readonly fileRunId?: string;
  readonly lineIndex?: number;
  readonly recordedAt?: string;
  readonly runId?: string;
  readonly type?: string;
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
  /** Decision-grade unique-run diagnostic. Legacy fields above retain their original three-outcome semantics. */
  readonly canonicalOutcomes: Readonly<Record<Exclude<(typeof CANONICAL_RUN_OUTCOMES)[number], never>, number>>;
  readonly gradedRuns: number;
  readonly measurement?: DecisionMetric;
  readonly measurementExclusionReason?: DecisionMetricExclusionReason;
  readonly measurementStatus: "available" | "excluded" | "insufficient";
  readonly technicalFailures: number;
  readonly technicalTopFailingTopics: readonly RunOutcomeTopic[];
}

const DEFAULT_MAX_TOPICS = 5;

export function analyzeRunOutcomes(
  entries: readonly RunOutcomeEntry[],
  options?: { readonly maxTopics?: number; readonly now?: Date }
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
  const canonical = canonicalRuns(entries, options?.now ?? new Date());
  const canonicalOutcomes = { abstain: 0, contested: 0, error: 0, grounded: 0, misgrounded: 0, ungrounded: 0 };
  const technicalFailingTopics = new Map<string, number>();
  for (const entry of canonical) {
    canonicalOutcomes[entry.grounded] += 1;
    if (entry.grounded !== "grounded") {
      const topic = topicKeyFromMessage(entry.message);
      if (topic.length > 0) technicalFailingTopics.set(topic, (technicalFailingTopics.get(topic) ?? 0) + 1);
    }
  }
  const gradedRuns = canonical.length;
  const technicalFailures = gradedRuns - canonicalOutcomes.grounded;
  const technicalTopFailingTopics = rankedTopics(technicalFailingTopics, maxTopics);
  let measurement: DecisionMetric | undefined;
  let measurementExclusionReason: DecisionMetricExclusionReason | undefined;
  if (canonical.length > 0) {
    const startedAt = canonical.reduce((earliest, entry) => entry.recordedAt < earliest ? entry.recordedAt : earliest, canonical[0]!.recordedAt);
    const endedAt = canonical.reduce((latest, entry) => entry.recordedAt > latest ? entry.recordedAt : latest, canonical[0]!.recordedAt);
    const evaluatedAt = (options?.now ?? new Date()).toISOString();
    const admission = admitDecisionMetric({
      actionId: "inspect-run-grounding",
      claim: "technical-diagnostic",
      evidenceClass: "unclassified",
      freshness: {
        asOf: endedAt,
        evaluatedAt,
        staleAfterMs: RUN_GROUNDING_FRESHNESS_MS,
        status: Date.parse(evaluatedAt) - Date.parse(endedAt) <= RUN_GROUNDING_FRESHNESS_MS ? "fresh" : "stale"
      },
      id: "run.grounding.failure-rate",
      schemaVersion: 1,
      source: { id: "run-grounding-log", version: 1 },
      value: { denominator: gradedRuns, numerator: technicalFailures, unit: "ratio" },
      window: { endedAt, startedAt }
    });
    if (admission.kind === "admitted") measurement = admission.metric;
    else measurementExclusionReason = admission.reason;
  }
  return {
    abstain,
    canonicalOutcomes,
    failRate: labelled === 0 ? 0 : failures / labelled,
    gradedRuns,
    grounded,
    labelled,
    ...(measurement ? { measurement } : {}),
    ...(measurementExclusionReason ? { measurementExclusionReason } : {}),
    measurementStatus: measurement ? "available" : measurementExclusionReason ? "excluded" : "insufficient",
    technicalFailures,
    technicalTopFailingTopics,
    topFailingTopics,
    ungrounded
  };
}

type CanonicalEntry = RunOutcomeEntry & {
  readonly grounded: (typeof CANONICAL_RUN_OUTCOMES)[number];
  readonly lineIndex: number;
  readonly recordedAt: string;
  readonly runId: string;
};

function canonicalInstant(value: string | undefined): value is string {
  if (value === undefined) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function canonicalRuns(entries: readonly RunOutcomeEntry[], now: Date): readonly CanonicalEntry[] {
  const latest = new Map<string, CanonicalEntry>();
  const nowIso = now.toISOString();
  for (const entry of entries) {
    if (entry.type !== "chat.completed" || !isCanonicalLocalRunId(entry.runId) || entry.fileRunId !== entry.runId
      || !canonicalInstant(entry.recordedAt) || entry.recordedAt > nowIso
      || entry.grounded === null || !(CANONICAL_RUN_OUTCOMES as readonly string[]).includes(entry.grounded)
      || !Number.isSafeInteger(entry.lineIndex) || Number(entry.lineIndex) < 0) continue;
    const candidate = entry as CanonicalEntry;
    const current = latest.get(candidate.runId);
    if (!current || candidate.recordedAt > current.recordedAt
      || (candidate.recordedAt === current.recordedAt && candidate.lineIndex > current.lineIndex)) {
      latest.set(candidate.runId, candidate);
    }
  }
  return [...latest.values()].sort((left, right) => left.recordedAt.localeCompare(right.recordedAt) || left.runId.localeCompare(right.runId));
}

function rankedTopics(topics: ReadonlyMap<string, number>, maxTopics: number): readonly RunOutcomeTopic[] {
  return [...topics.entries()]
    .map(([topic, count]) => ({ count, topic }))
    .sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic))
    .slice(0, maxTopics);
}
