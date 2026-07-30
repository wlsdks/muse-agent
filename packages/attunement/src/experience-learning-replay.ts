import { sha256Hex } from "@muse/shared";

import type { ExperienceLearningCandidate } from "./experience-learning-candidate.js";

export interface ExperienceReplayObservation {
  readonly evidenceHash: string;
  readonly passed: boolean;
}

export interface ExperienceReplayCase {
  readonly baseline: ExperienceReplayObservation;
  readonly caseId: string;
  readonly challenger: ExperienceReplayObservation;
}

export interface ExperienceLearningReplay {
  readonly aggregate: {
    readonly baselinePassed: number;
    readonly challengerPassed: number;
    readonly improvements: number;
    readonly regressions: number;
    readonly ties: number;
    readonly total: number;
  };
  readonly candidateId: string;
  readonly caseIds: readonly string[];
  readonly inputHash: string;
  readonly promotionApplied: false;
  readonly recommendation: "eligible-for-review" | "hold";
  readonly replayStatus: "frozen";
  readonly schemaVersion: 1;
}

const SHA256 = /^[a-f0-9]{64}$/u;
const CASE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

/**
 * Compare one proposal against its active baseline on the exact same frozen
 * observations. This can recommend owner review but never mutates or activates
 * policy. Any regression or all-tie result holds the candidate.
 */
export function compareExperienceLearningReplay(
  candidate: ExperienceLearningCandidate,
  cases: readonly ExperienceReplayCase[]
): ExperienceLearningReplay | undefined {
  if (candidate.status !== "proposed" || candidate.activation !== "none" || cases.length === 0) {
    return undefined;
  }
  const seen = new Set<string>();
  const frozen: ExperienceReplayCase[] = [];
  for (const entry of cases) {
    if (!CASE_ID.test(entry.caseId)
      || seen.has(entry.caseId)
      || !validObservation(entry.baseline)
      || !validObservation(entry.challenger)) {
      return undefined;
    }
    seen.add(entry.caseId);
    frozen.push(Object.freeze({
      baseline: Object.freeze({ ...entry.baseline }),
      caseId: entry.caseId,
      challenger: Object.freeze({ ...entry.challenger })
    }));
  }
  frozen.sort((left, right) => left.caseId.localeCompare(right.caseId));
  let baselinePassed = 0;
  let challengerPassed = 0;
  let improvements = 0;
  let regressions = 0;
  let ties = 0;
  for (const entry of frozen) {
    if (entry.baseline.passed) baselinePassed += 1;
    if (entry.challenger.passed) challengerPassed += 1;
    if (!entry.baseline.passed && entry.challenger.passed) improvements += 1;
    else if (entry.baseline.passed && !entry.challenger.passed) regressions += 1;
    else ties += 1;
  }
  const caseIds = Object.freeze(frozen.map((entry) => entry.caseId));
  const inputHash = sha256Hex(JSON.stringify({
    activeBehaviorDigestBefore: candidate.activeBehaviorDigestBefore,
    candidateId: candidate.candidateId,
    cases: frozen
  }));
  return Object.freeze({
    aggregate: Object.freeze({
      baselinePassed,
      challengerPassed,
      improvements,
      regressions,
      ties,
      total: frozen.length
    }),
    candidateId: candidate.candidateId,
    caseIds,
    inputHash,
    promotionApplied: false,
    recommendation: improvements > 0 && regressions === 0
      ? "eligible-for-review"
      : "hold",
    replayStatus: "frozen",
    schemaVersion: 1
  });
}

function validObservation(value: ExperienceReplayObservation): boolean {
  return typeof value.passed === "boolean" && SHA256.test(value.evidenceHash);
}
