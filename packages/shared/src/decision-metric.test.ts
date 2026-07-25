import { describe, expect, it } from "vitest";

import { admitDecisionMetric } from "./decision-metric.js";

const BASE = {
  actionId: "inspect-run-grounding",
  claim: "technical-diagnostic",
  dataOrigin: "production",
  executionEvidence: "deterministic",
  freshness: {
    asOf: "2026-07-22T00:00:00.000Z",
    evaluatedAt: "2026-07-22T12:00:00.000Z",
    staleAfterMs: 604_800_000,
    status: "fresh"
  },
  id: "run.grounding.failure-rate",
  schemaVersion: 2,
  source: { id: "run-grounding-log", version: 1 },
  value: { denominator: 4, numerator: 1, unit: "ratio" },
  window: { endedAt: "2026-07-22T00:00:00.000Z", startedAt: "2026-07-21T00:00:00.000Z" }
} as const;

function expectExcluded(input: unknown, reason: string): void {
  expect(admitDecisionMetric(input)).toEqual({ kind: "excluded", reason });
}

describe("admitDecisionMetric", () => {
  it("admits the exact run-grounding tuple", () => {
    expect(admitDecisionMetric(BASE)).toEqual({ kind: "admitted", metric: BASE });
  });

  it.each([
    ["production", "organic-production", "personal-effectiveness", "inspect-run-grounding"],
    ["production", "deterministic", "learning", "inspect-run-grounding"],
    ["production", "deterministic", "autonomy", "inspect-run-grounding"],
    ["production", "deterministic", "technical-diagnostic", "review-continuity-feedback"]
  ] as const)("rejects semantic laundering through %s/%s/%s/%s", (dataOrigin, executionEvidence, claim, actionId) => {
    expectExcluded({ ...BASE, actionId, claim, dataOrigin, executionEvidence }, "incoherent-source-contract");
  });

  it("admits only coherent Attunement personal and technical tuples", () => {
    const personal = {
      ...BASE,
      actionId: "review-continuity-feedback",
      claim: "personal-effectiveness",
      dataOrigin: "production",
      executionEvidence: "organic-production",
      freshness: { ...BASE.freshness, staleAfterMs: 2_592_000_000 },
      id: "continuity.first-20.used.work",
      source: { id: "attunement-state", version: 8 }
    } as const;
    const technical = {
      ...personal,
      actionId: "inspect-continuity-technical-evidence",
      claim: "technical-diagnostic",
      dataOrigin: "unclassified",
      executionEvidence: "controlled-live",
      id: "continuity.technical.delivery.controlled.work",
      value: { denominator: 4, numerator: 1, unit: "count-of-total" }
    } as const;

    expect(admitDecisionMetric(personal).kind).toBe("admitted");
    expect(admitDecisionMetric(technical).kind).toBe("admitted");
    expectExcluded({ ...technical, dataOrigin: "synthetic", executionEvidence: "organic-production" }, "incoherent-source-contract");
    expectExcluded({ ...personal, claim: "learning" }, "incoherent-source-contract");
    expectExcluded({ ...personal, claim: "autonomy" }, "incoherent-source-contract");
  });

  it("requires origin and execution evidence independently and never promotes synthetic or weaker execution", () => {
    const { dataOrigin: _dataOrigin, ...missingOrigin } = BASE;
    const { executionEvidence: _executionEvidence, ...missingExecution } = BASE;
    const personal = {
      ...BASE,
      actionId: "review-continuity-feedback",
      claim: "personal-effectiveness",
      freshness: { ...BASE.freshness, staleAfterMs: 2_592_000_000 },
      id: "continuity.first-20.used.work",
      source: { id: "attunement-state", version: 8 }
    } as const;

    expectExcluded(missingOrigin, "invalid-shape");
    expectExcluded(missingExecution, "invalid-shape");
    expectExcluded({ ...personal, dataOrigin: "synthetic", executionEvidence: "organic-production" }, "incoherent-source-contract");
    expectExcluded({ ...personal, dataOrigin: "production", executionEvidence: "deterministic" }, "incoherent-source-contract");
    expectExcluded({ ...personal, dataOrigin: "production", executionEvidence: "controlled-live" }, "incoherent-source-contract");
  });

  it.each([
    [{ ...BASE, value: { ...BASE.value, denominator: 0 } }, "invalid-value"],
    [{ ...BASE, value: { ...BASE.value, numerator: 5 } }, "invalid-value"],
    [{ ...BASE, value: { ...BASE.value, numerator: 0.5 } }, "invalid-value"],
    [{ ...BASE, window: { ...BASE.window, startedAt: "not-a-time" } }, "invalid-window"],
    [{ ...BASE, window: { endedAt: BASE.window.startedAt, startedAt: BASE.window.endedAt } }, "invalid-window"],
    [{ ...BASE, freshness: { ...BASE.freshness, asOf: "2026-07-23T00:00:00.000Z" } }, "invalid-freshness"],
    [{ ...BASE, freshness: { ...BASE.freshness, evaluatedAt: "2026-08-22T12:00:00.000Z", status: "fresh" } }, "invalid-freshness"],
    [{ ...BASE, dataOrigin: "guessed" }, "invalid-shape"],
    [{ ...BASE, executionEvidence: "self-reported" }, "invalid-shape"],
    [{ ...BASE, schemaVersion: 1 }, "invalid-shape"],
    [{ ...BASE, source: { id: "unknown", version: 1 } }, "unsupported-source"]
  ] as const)("excludes malformed input with %s", (input, reason) => {
    expectExcluded(input, reason);
  });

  it("rejects unknown fields instead of accepting an expanded schema accidentally", () => {
    expectExcluded({ ...BASE, guessedProvenance: true }, "invalid-shape");
  });

  it("binds freshness TTL to the source contract", () => {
    expectExcluded({ ...BASE, freshness: { ...BASE.freshness, staleAfterMs: 86_400_000 } }, "incoherent-source-contract");
  });

  it("exhaustively enforces the source, metric id, claim, evidence, unit, and action matrix", () => {
    const sources = [{ id: "run-grounding-log", version: 1 }, { id: "attunement-state", version: 8 }] as const;
    const claims = ["technical-diagnostic", "personal-effectiveness", "learning", "autonomy"] as const;
    const dataOrigins = ["synthetic", "production", "unclassified"] as const;
    const executionEvidenceValues = ["deterministic", "controlled-live", "organic-production"] as const;
    const metricEvidenceIds = ["organic", "controlled", "unclassified"] as const;
    const units = ["ratio", "count-of-total"] as const;
    const actions = ["inspect-run-grounding", "review-continuity-feedback", "inspect-continuity-technical-evidence"] as const;
    const scopes = ["overall", "life", "work"] as const;
    const metricIds = [
      "run.grounding.failure-rate",
      ...scopes.flatMap((scope) => [
        `continuity.first-20.used.${scope}`,
        `continuity.first-20.rejected.${scope}`,
        ...(["delivery", "outcome"] as const).flatMap((kind) => metricEvidenceIds.map((evidenceClass) => `continuity.technical.${kind}.${evidenceClass}.${scope}`))
      ])
    ];

    for (const currentSource of sources) for (const id of metricIds) for (const claim of claims) {
      for (const dataOrigin of dataOrigins) for (const executionEvidence of executionEvidenceValues) {
        for (const unit of units) for (const actionId of actions) {
        const runValid = currentSource.id === "run-grounding-log"
          && id === "run.grounding.failure-rate" && claim === "technical-diagnostic"
          && executionEvidence === "deterministic"
          && unit === "ratio" && actionId === "inspect-run-grounding";
        const personalValid = currentSource.id === "attunement-state"
          && /^continuity\.first-20\.(used|rejected)\.(overall|life|work)$/u.test(id)
          && claim === "personal-effectiveness" && dataOrigin === "production"
          && executionEvidence === "organic-production"
          && unit === "ratio" && actionId === "review-continuity-feedback";
        const technicalMatch = /^continuity\.technical\.(delivery|outcome)\.(organic|controlled|unclassified)\.(overall|life|work)$/u.exec(id);
        const technicalValid = currentSource.id === "attunement-state"
          && (technicalMatch?.[2] === "organic"
            ? dataOrigin === "production" && executionEvidence === "organic-production"
            : technicalMatch?.[2] === "controlled"
              ? dataOrigin === "unclassified" && executionEvidence === "controlled-live"
              : technicalMatch?.[2] === "unclassified"
                && dataOrigin === "unclassified" && executionEvidence === "deterministic")
          && claim === "technical-diagnostic" && unit === "count-of-total"
          && actionId === "inspect-continuity-technical-evidence";
        const result = admitDecisionMetric({
          ...BASE,
          actionId,
          claim,
          dataOrigin,
          executionEvidence,
          freshness: {
            ...BASE.freshness,
            staleAfterMs: currentSource.id === "run-grounding-log" ? 604_800_000 : 2_592_000_000
          },
          id,
          source: currentSource,
          value: { ...BASE.value, unit }
        });

        expect(result.kind, `${currentSource.id}/${id}/${claim}/${dataOrigin}/${executionEvidence}/${unit}/${actionId}`)
          .toBe(runValid || personalValid || technicalValid ? "admitted" : "excluded");
        }
      }
    }
  });
});
