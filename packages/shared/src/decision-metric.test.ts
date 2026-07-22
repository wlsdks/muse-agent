import { describe, expect, it } from "vitest";

import { admitDecisionMetric, type DecisionMetricInput } from "./decision-metric.js";

const BASE: DecisionMetricInput = {
  actionId: "inspect-run-grounding",
  claim: "technical-diagnostic",
  evidenceClass: "unclassified",
  freshness: {
    asOf: "2026-07-22T00:00:00.000Z",
    evaluatedAt: "2026-07-22T12:00:00.000Z",
    staleAfterMs: 604_800_000,
    status: "fresh"
  },
  id: "run.grounding.failure-rate",
  schemaVersion: 1,
  source: { id: "run-grounding-log", version: 1 },
  value: { denominator: 4, numerator: 1, unit: "ratio" },
  window: { endedAt: "2026-07-22T00:00:00.000Z", startedAt: "2026-07-21T00:00:00.000Z" }
};

function expectExcluded(input: unknown, reason: string): void {
  expect(admitDecisionMetric(input)).toEqual({ kind: "excluded", reason });
}

describe("admitDecisionMetric", () => {
  it("admits the exact run-grounding tuple", () => {
    expect(admitDecisionMetric(BASE)).toEqual({ kind: "admitted", metric: BASE });
  });

  it.each([
    ["organic", "personal-effectiveness", "inspect-run-grounding"],
    ["unclassified", "learning", "inspect-run-grounding"],
    ["unclassified", "autonomy", "inspect-run-grounding"],
    ["unclassified", "technical-diagnostic", "review-continuity-feedback"]
  ] as const)("rejects semantic laundering through %s/%s/%s", (evidenceClass, claim, actionId) => {
    expectExcluded({ ...BASE, actionId, claim, evidenceClass }, "incoherent-source-contract");
  });

  it("admits only coherent Attunement personal and technical tuples", () => {
    const personal = {
      ...BASE,
      actionId: "review-continuity-feedback",
      claim: "personal-effectiveness",
      evidenceClass: "organic",
      freshness: { ...BASE.freshness, staleAfterMs: 2_592_000_000 },
      id: "continuity.first-20.used.work",
      source: { id: "attunement-state", version: 8 }
    } as const;
    const technical = {
      ...personal,
      actionId: "inspect-continuity-technical-evidence",
      claim: "technical-diagnostic",
      evidenceClass: "controlled",
      id: "continuity.technical.delivery.controlled.work",
      value: { denominator: 4, numerator: 1, unit: "count-of-total" }
    } as const;

    expect(admitDecisionMetric(personal).kind).toBe("admitted");
    expect(admitDecisionMetric(technical).kind).toBe("admitted");
    expectExcluded({ ...technical, evidenceClass: "organic" }, "incoherent-source-contract");
    expectExcluded({ ...personal, claim: "learning" }, "incoherent-source-contract");
    expectExcluded({ ...personal, claim: "autonomy" }, "incoherent-source-contract");
  });

  it.each([
    [{ ...BASE, value: { ...BASE.value, denominator: 0 } }, "invalid-value"],
    [{ ...BASE, value: { ...BASE.value, numerator: 5 } }, "invalid-value"],
    [{ ...BASE, value: { ...BASE.value, numerator: 0.5 } }, "invalid-value"],
    [{ ...BASE, window: { ...BASE.window, startedAt: "not-a-time" } }, "invalid-window"],
    [{ ...BASE, window: { endedAt: BASE.window.startedAt, startedAt: BASE.window.endedAt } }, "invalid-window"],
    [{ ...BASE, freshness: { ...BASE.freshness, asOf: "2026-07-23T00:00:00.000Z" } }, "invalid-freshness"],
    [{ ...BASE, freshness: { ...BASE.freshness, evaluatedAt: "2026-08-22T12:00:00.000Z", status: "fresh" } }, "invalid-freshness"],
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
    const evidenceClasses = ["organic", "controlled", "unclassified"] as const;
    const units = ["ratio", "count-of-total"] as const;
    const actions = ["inspect-run-grounding", "review-continuity-feedback", "inspect-continuity-technical-evidence"] as const;
    const scopes = ["overall", "life", "work"] as const;
    const metricIds = [
      "run.grounding.failure-rate",
      ...scopes.flatMap((scope) => [
        `continuity.first-20.used.${scope}`,
        `continuity.first-20.rejected.${scope}`,
        ...(["delivery", "outcome"] as const).flatMap((kind) => evidenceClasses.map((evidenceClass) => `continuity.technical.${kind}.${evidenceClass}.${scope}`))
      ])
    ];

    for (const currentSource of sources) for (const id of metricIds) for (const claim of claims) {
      for (const evidenceClass of evidenceClasses) for (const unit of units) for (const actionId of actions) {
        const runValid = currentSource.id === "run-grounding-log"
          && id === "run.grounding.failure-rate" && claim === "technical-diagnostic"
          && evidenceClass === "unclassified" && unit === "ratio" && actionId === "inspect-run-grounding";
        const personalValid = currentSource.id === "attunement-state"
          && /^continuity\.first-20\.(used|rejected)\.(overall|life|work)$/u.test(id)
          && claim === "personal-effectiveness" && evidenceClass === "organic"
          && unit === "ratio" && actionId === "review-continuity-feedback";
        const technicalMatch = /^continuity\.technical\.(delivery|outcome)\.(organic|controlled|unclassified)\.(overall|life|work)$/u.exec(id);
        const technicalValid = currentSource.id === "attunement-state" && technicalMatch?.[2] === evidenceClass
          && claim === "technical-diagnostic" && unit === "count-of-total"
          && actionId === "inspect-continuity-technical-evidence";
        const result = admitDecisionMetric({
          ...BASE,
          actionId,
          claim,
          evidenceClass,
          freshness: {
            ...BASE.freshness,
            staleAfterMs: currentSource.id === "run-grounding-log" ? 604_800_000 : 2_592_000_000
          },
          id,
          source: currentSource,
          value: { ...BASE.value, unit }
        });

        expect(result.kind, `${currentSource.id}/${id}/${claim}/${evidenceClass}/${unit}/${actionId}`)
          .toBe(runValid || personalValid || technicalValid ? "admitted" : "excluded");
      }
    }
  });
});
