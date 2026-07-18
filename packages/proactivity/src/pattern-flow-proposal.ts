/**
 * Pure bridge: observed patterns (`@muse/memory`'s detectors) → Builder
 * automation proposals ("3주 연속 월요일 오전에 X를 하셨네요 — 흐름으로
 * 만들까요?"). No I/O — the caller supplies the already-detected matches and
 * the already-rejected pattern ids; this module only decides WHICH matches
 * clear the evidence bar and shapes them into a receipt-bearing proposal.
 *
 * Draft-first stays intact one layer up: this never creates anything. The
 * web layer takes a proposal's `suggestionText` + `cronExpression` and
 * prefills the Builder create panel — the user still clicks 만들기.
 */

import type { PatternMatch, Weekday } from "@muse/memory";

export interface FlowProposalReceipt {
  readonly observationCount: number;
  /** Distinct days (time-of-day-action) or distinct ISO weeks (weekly-task) the pattern was observed in. */
  readonly distinctCount: number;
  readonly distinctUnit: "days" | "weeks";
  /** Up to `maxExamples` related paths/titles, most-recent-first (as the detector ordered them). */
  readonly examples: readonly string[];
  readonly confidence: number;
}

export interface FlowProposal {
  /** Stable = the source pattern's id, so accept/reject and re-detection all key off the same value. */
  readonly id: string;
  readonly title: string;
  /** Korean natural-language line for the Builder copilot seed, e.g. "매주 월요일 오전 9시에 <suggestion>". */
  readonly suggestionText: string;
  /** 5-field cron (`minute hour day month weekday`), minute always 0. */
  readonly cronExpression: string;
  readonly category: PatternMatch["category"];
  readonly receipt: FlowProposalReceipt;
}

export interface ProposeFlowsFromPatternsOptions {
  /** Confidence floor. Default 0.7 — the same bar `selectFireablePatterns` uses for an actual proactive send, so a proposal is never weaker evidence than what Muse would otherwise interrupt the user for. */
  readonly minConfidence?: number;
  /** Minimum observation count (the detector's own `bucket.matches`). Default 3 — never propose from fewer than 3 observed instances. */
  readonly minObservationCount?: number;
  /** Cap on returned proposals. Default 2 (no spam). */
  readonly maxProposals?: number;
  /** Cap on `receipt.examples`. Default 3. */
  readonly maxExamples?: number;
}

const DEFAULT_MIN_CONFIDENCE = 0.7;
const DEFAULT_MIN_OBSERVATION_COUNT = 3;
const DEFAULT_MAX_PROPOSALS = 2;
const DEFAULT_MAX_EXAMPLES = 3;
/** Weekly-task matches carry no hour-of-day signal (only a weekday) — anchor
 * to a conventional morning slot the user can still edit before creating. */
const DEFAULT_WEEKLY_TASK_HOUR = 9;

const WEEKDAY_KO: Readonly<Record<Weekday, string>> = {
  Fri: "금요일",
  Mon: "월요일",
  Sat: "토요일",
  Sun: "일요일",
  Thu: "목요일",
  Tue: "화요일",
  Wed: "수요일"
};

const WEEKDAY_CRON_DOW: Readonly<Record<Weekday, number>> = {
  Fri: 5,
  Mon: 1,
  Sat: 6,
  Sun: 0,
  Thu: 4,
  Tue: 2,
  Wed: 3
};

function hourBandStartHour(hourBand: string): number {
  const start = Number.parseInt(hourBand.split("-")[0] ?? "", 10);
  return Number.isFinite(start) ? start : DEFAULT_WEEKLY_TASK_HOUR;
}

function koreanClockLabel(hour: number): string {
  if (hour === 0) return "오전 12시";
  if (hour < 12) return `오전 ${hour.toString()}시`;
  if (hour === 12) return "오후 12시";
  return `오후 ${(hour - 12).toString()}시`;
}

function anchorHourOf(match: PatternMatch): number {
  return match.category === "time-of-day-action" ? hourBandStartHour(match.bucket.hourBand) : DEFAULT_WEEKLY_TASK_HOUR;
}

function observationCountOf(match: PatternMatch): number {
  return match.bucket.matches;
}

function distinctCountOf(match: PatternMatch): number {
  return match.category === "time-of-day-action" ? match.bucket.distinctDays : match.bucket.distinctWeeks;
}

function examplesOf(match: PatternMatch, cap: number): readonly string[] {
  const source = match.category === "time-of-day-action" ? match.relatedPaths : match.relatedTitles;
  return source.slice(0, Math.max(0, cap));
}

function titleOf(match: PatternMatch): string {
  if (match.category === "time-of-day-action") {
    return `${WEEKDAY_KO[match.bucket.weekday]} ${koreanClockLabel(anchorHourOf(match))} 루틴`;
  }
  return `매주 반복: ${match.bucket.titleTemplate}`;
}

function suggestionTextOf(match: PatternMatch): string {
  const weekday = WEEKDAY_KO[match.bucket.weekday];
  const clock = koreanClockLabel(anchorHourOf(match));
  return `매주 ${weekday} ${clock}에 ${match.suggestion}`;
}

function cronExpressionOf(match: PatternMatch): string {
  const hour = anchorHourOf(match);
  const dow = WEEKDAY_CRON_DOW[match.bucket.weekday];
  return `0 ${hour.toString()} * * ${dow.toString()}`;
}

function toProposal(match: PatternMatch, maxExamples: number): FlowProposal {
  return {
    category: match.category,
    cronExpression: cronExpressionOf(match),
    id: match.id,
    receipt: {
      confidence: match.confidence,
      distinctCount: distinctCountOf(match),
      distinctUnit: match.category === "time-of-day-action" ? "days" : "weeks",
      examples: examplesOf(match, maxExamples),
      observationCount: observationCountOf(match)
    },
    suggestionText: suggestionTextOf(match),
    title: titleOf(match)
  };
}

/**
 * Evidence gate (fail-close, deterministic): a match becomes a proposal
 * ONLY when its OWN countable evidence clears both bars — confidence AND
 * a minimum observation count. There is no fallback path that proposes a
 * pattern lacking one of these fields; every `PatternMatch` variant
 * carries `confidence` and `bucket.matches`, so "can't tell" never arises,
 * but if the union ever grows a variant without countable evidence, the
 * type of `observationCountOf`/`distinctCountOf` would fail to compile
 * rather than silently guessing.
 */
export function proposeFlowsFromPatterns(
  matches: readonly PatternMatch[],
  rejectedIds: readonly string[],
  options: ProposeFlowsFromPatternsOptions = {}
): readonly FlowProposal[] {
  const minConfidence = Number.isFinite(options.minConfidence) ? options.minConfidence! : DEFAULT_MIN_CONFIDENCE;
  const minObservationCount = Number.isFinite(options.minObservationCount)
    ? Math.trunc(options.minObservationCount!)
    : DEFAULT_MIN_OBSERVATION_COUNT;
  const maxProposals = Math.max(
    0,
    Number.isFinite(options.maxProposals) ? Math.trunc(options.maxProposals!) : DEFAULT_MAX_PROPOSALS
  );
  const maxExamples = Math.max(
    0,
    Number.isFinite(options.maxExamples) ? Math.trunc(options.maxExamples!) : DEFAULT_MAX_EXAMPLES
  );

  const rejected = new Set(rejectedIds);

  const eligible = matches.filter((match) => {
    if (rejected.has(match.id)) return false;
    if (match.confidence < minConfidence) return false;
    if (observationCountOf(match) < minObservationCount) return false;
    return true;
  });

  const sorted = [...eligible].sort((left, right) => right.confidence - left.confidence);

  return sorted.slice(0, maxProposals).map((match) => toProposal(match, maxExamples));
}
