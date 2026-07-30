import { createHash } from "node:crypto";

import {
  createExperienceReplayEvidenceReceipt,
  fingerprintContinuityPolicy,
  policyForOutcome
} from "@muse/attunement";
import {
  createLocalAttunementSnapshotProviderForTesting
} from "@muse/attunement/testing";
import { parseAttunementState } from "@muse/attunement/state-validation";
import { afterEach, describe, expect, it, vi } from "vitest";

const observationDouble = vi.hoisted(() => ({
  mode: "normal" as
    | "ambiguous"
    | "ambiguous-temporal"
    | "final-budget"
    | "graph-scope"
    | "invalid"
    | "invalid-missing"
    | "missing"
    | "missing-ambiguous"
    | "normal"
    | "observation-time"
    | "scoped-basis"
    | "temporal"
    | "temporal-budget"
    | "throws-late"
}));
const attunementDouble = vi.hoisted(() => ({ throwQueue: false }));

vi.mock("@muse/attunement", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@muse/attunement")>();
  return {
    ...actual,
    buildExperienceLearningReviewQueue(
      ...args: Parameters<typeof actual.buildExperienceLearningReviewQueue>
    ) {
      if (attunementDouble.throwQueue) {
        throw new Error("/private/path must not escape");
      }
      return actual.buildExperienceLearningReviewQueue(...args);
    }
  };
});

vi.mock("./continuity-observation.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./continuity-observation.js")>();
  return {
    ...actual,
    verifyContinuityObservation(
      value: Parameters<typeof actual.verifyContinuityObservation>[0]
    ) {
      const verified = actual.verifyContinuityObservation(value);
      if (
        observationDouble.mode === "invalid"
        || observationDouble.mode === "invalid-missing"
      ) {
        throw new TypeError("synthetic graph verification failure");
      }
      if (observationDouble.mode === "normal") return verified;
      const assertions = [...verified.projection.assertions];
      const deliveredForIndex = assertions.findIndex((assertion) =>
        assertion.predicate === "DELIVERED_FOR"
      );
      if (
        observationDouble.mode === "missing"
        || observationDouble.mode === "missing-ambiguous"
      ) {
        assertions.splice(deliveredForIndex, 1);
      }
      if (
        observationDouble.mode === "ambiguous"
        || observationDouble.mode === "ambiguous-temporal"
        || observationDouble.mode === "missing-ambiguous"
      ) {
        const original = assertions[deliveredForIndex]!;
        assertions.push(Object.freeze({
          ...original,
          id: `${original.id}_synthetic_duplicate`
        }));
      }
      if (
        observationDouble.mode === "temporal"
        || observationDouble.mode === "ambiguous-temporal"
        || observationDouble.mode === "temporal-budget"
      ) {
        const original = assertions[deliveredForIndex]!;
        assertions[deliveredForIndex] = Object.freeze({
          ...original,
          recordedAt: "2026-07-31T09:00:00.001Z"
        });
      }
      const projection = {
        ...verified.projection,
        assertions: Object.freeze(assertions),
        ...(observationDouble.mode === "final-budget"
          || observationDouble.mode === "temporal-budget"
          ? { sourceVersion: "x".repeat(70 * 1024) }
          : {}),
        ...(observationDouble.mode === "graph-scope"
          ? {
              scope: {
                ...verified.projection.scope,
                threadId: "thread_other"
              }
            }
          : {}),
        ...(observationDouble.mode === "scoped-basis"
          ? {
              timestampBasis: verified.projection.timestampBasis.map((entry) =>
                Object.freeze({
                  ...entry,
                  basis: entry.basis === "source-event"
                    ? "source-observation" as const
                    : "source-event" as const
                })
              )
            }
          : {})
      };
      if (observationDouble.mode === "throws-late") {
        Object.defineProperty(projection, "sourceVersion", {
          enumerable: true,
          get() {
            throw new Error("/private/path must not escape");
          }
        });
      }
      return Object.freeze({
        ...verified,
        ...(observationDouble.mode === "observation-time"
          ? { observedAt: "2026-07-31T10:00:00.999Z" }
          : {}),
        projection: Object.freeze(projection)
      });
    }
  };
});

import {
  compileAttuneGraphPolicyCard,
  type AttuneGraphPolicyCardCompileInputV1
} from "./policy-card.js";
import {
  POLICY_CARD_MAX_BYTES,
  settleAttuneGraphPolicyCardBudget
} from "./policy-card-finalization.js";

const SOURCE_ID = "muse.local-attunement";
const THREAD_ID = "thread_policy_card";
const DELIVERY_ID = "delivery_policy_card";
const RUN_ID = "continuity_run_policy_card";
const OPENED_AT = "2026-07-31T09:00:00.000Z";
const OUTCOME_AT = "2026-07-31T09:05:00.000Z";
const CAPTURE_AT = "2026-07-31T10:00:00.000Z";

const DELIVERY_POLICY = Object.freeze({
  detail: "compact" as const,
  nextStep: "direct" as const,
  suppression: "none" as const,
  version: 0
});
const CURRENT_POLICY = Object.freeze(policyForOutcome("ignored", 1));

function outcomeId(
  evidenceClass: "controlled" | "organic" = "organic"
): string {
  return `continuity_outcome_${createHash("sha256")
    .update(JSON.stringify([
      "muse.continuity-outcome.v1",
      DELIVERY_ID,
      RUN_ID,
      "ignored",
      null,
      OUTCOME_AT,
      evidenceClass
    ]))
    .digest("hex")}`;
}

function state(
  evidenceClass: "controlled" | "organic" = "organic"
) {
  return parseAttunementState({
    deliveries: [{
      evidenceClass,
      evidenceRefs: [],
      id: DELIVERY_ID,
      openedAt: OPENED_AT,
      outcome: {
        authority: "owner-explicit",
        evidenceClass,
        id: outcomeId(evidenceClass),
        outcome: "ignored",
        policyVersion: 1,
        recordedAt: OUTCOME_AT
      },
      policyDigest: fingerprintContinuityPolicy(DELIVERY_POLICY),
      policyVersion: 0,
      runId: RUN_ID,
      threadId: THREAD_ID
    }],
    interactionReceipts: [],
    nextPolicyVersion: 2,
    resetReceipts: [],
    schemaVersion: 11,
    threads: [{
      createdAt: "2026-07-31T08:00:00.000Z",
      id: THREAD_ID,
      kind: "work",
      links: [],
      policy: CURRENT_POLICY,
      title: "Policy Card fixture"
    }],
    undoResetReceipts: []
  });
}

function evidenceReceipt(
  caseId: string,
  variant: "baseline" | "challenger",
  passed: boolean
) {
  return createExperienceReplayEvidenceReceipt({
    caseId,
    evaluator: { id: "caller-controlled-grader", version: "1.0.0" },
    inputHash: "f".repeat(64),
    observedAt: "2026-07-31T09:30:00.000Z",
    passed,
    variant
  })!;
}

function evidenceCases() {
  return [{
    baseline: evidenceReceipt("case-policy-card", "baseline", false),
    caseId: "case-policy-card",
    challenger: evidenceReceipt("case-policy-card", "challenger", true)
  }];
}

async function fixture(options: {
  readonly changed?: boolean;
  readonly evidenceClass?: "controlled" | "organic";
} = {}) {
  let clock = 0;
  let reads = 0;
  const provider = createLocalAttunementSnapshotProviderForTesting(
    {
      attunementFile: "/configured/attunement.json",
      sourceId: SOURCE_ID
    },
    {
      clock: () => new Date(
        Date.parse(CAPTURE_AT) + clock++ * 25
      ),
      readState: async () => {
        const value = state(options.evidenceClass);
        if (options.changed && reads++ > 0) {
          return {
            state: {
              ...value,
              threads: value.threads.map((thread) => ({
                ...thread,
                title: "Changed during revalidation"
              }))
            },
            status: "available" as const
          };
        }
        reads++;
        return { state: value, status: "available" as const };
      }
    }
  );
  const scope = { sourceId: SOURCE_ID, threadId: THREAD_ID };
  const headRevalidation = await provider.captureHeadRevalidation(
    scope,
    { maxCaptureSpanMs: 25 }
  );
  const queue = (await import("@muse/attunement"))
    .buildExperienceLearningReviewQueue(state(options.evidenceClass));
  return {
    headRevalidation,
    opportunityId: queue.items[0]!.opportunityId
  };
}

function draft() {
  return {
    expectedBenefit: "Reduce interruptions during focused work.",
    expiresAt: "2026-08-01T09:06:00.000Z",
    experienceId: "experience-policy-card",
    proposedAt: "2026-07-31T09:06:00.000Z",
    proposedBehavior: "Wait for an explicit review window before suggesting.",
    proposedChange: {
      adjustment: "increase-cooldown",
      kind: "thread-timing"
    },
    scope: { kind: "thread-timing", threadId: THREAD_ID }
  };
}

async function input(
  locale: "en" | "ko" = "en"
): Promise<AttuneGraphPolicyCardCompileInputV1> {
  const source = await fixture();
  return {
    schemaVersion: 1,
    draft: draft(),
    evidenceCases: evidenceCases(),
    headRevalidation: source.headRevalidation,
    locale,
    opportunityId: source.opportunityId
  };
}

describe("AttuneGraph Policy Card", () => {
  afterEach(() => {
    observationDouble.mode = "normal";
    attunementDouble.throwQueue = false;
  });

  it("renders one frozen claim-safe card with separate evidence ledgers", async () => {
    const result = compileAttuneGraphPolicyCard(await input("ko"));

    expect(result.status).toBe("rendered");
    if (result.status !== "rendered") return;
    expect(result.card).toMatchObject({
      assessedSnapshot: {
        currentWorldFreshness: false,
        freshness: "provider-head-matched-at-assessment",
        providerAttestedDerivedGraph: false
      },
      boundary: { activation: "none", approval: "none", effect: "none" },
      evidence: {
        authoritativeExperience: {
          evidenceClass: "organic-production",
          label: "실사용자 사용 결과"
        },
        callerSuppliedReplayClaims: {
          executionProvenanceVerified: false,
          validation: "structurally-validated-self-consistent-caller-claims"
        },
        graphExplanation: {
          providerAttested: false,
          provenance:
            "locally-derived-from-provider-head-matched-assessed-snapshot"
        }
      },
      locale: "ko",
      scope: {
        kind: "thread-only",
        sourceId: SOURCE_ID,
        threadId: THREAD_ID
      }
    });
    expect(result.card.evidence.graphExplanation.assertionIds).toHaveLength(4);
    expect(result.card.controls.map((control) => [
      control.kind,
      control.availability,
      control.approvalGranted,
      control.effectPerformed
    ])).toEqual([
      ["trial", "unavailable_in_preview", false, false],
      ["edit", "unavailable_in_preview", false, false],
      ["reject", "unavailable_in_preview", false, false],
      ["apply", "external_to_preview", false, false],
      ["rollback", "unavailable_in_preview", false, false]
    ]);
    expect(Object.isFrozen(result.card)).toBe(true);
    expect(Object.isFrozen(result.card.evidence)).toBe(true);
    expect(JSON.stringify(result.card)).not.toMatch(
      /callback|approvalToken|toolArgs|https?:\/\//u
    );
  });

  it("shares semantic identity across locales and separates render identity", async () => {
    const common = await fixture();
    const base = {
      schemaVersion: 1 as const,
      draft: draft(),
      evidenceCases: evidenceCases(),
      headRevalidation: common.headRevalidation,
      opportunityId: common.opportunityId
    };
    const english = compileAttuneGraphPolicyCard({ ...base, locale: "en" });
    const korean = compileAttuneGraphPolicyCard({ ...base, locale: "ko" });

    expect(english.status).toBe("rendered");
    expect(korean.status).toBe("rendered");
    if (english.status !== "rendered" || korean.status !== "rendered") return;
    expect(english.card.cardId).toBe(korean.card.cardId);
    expect(english.card.renderId).not.toBe(korean.card.renderId);
    expect(english.card.title).not.toBe(korean.card.title);
  });

  it("changes semantic identity when a bound proposal dependency changes", async () => {
    const common = await fixture();
    const first = compileAttuneGraphPolicyCard({
      schemaVersion: 1,
      draft: draft(),
      evidenceCases: evidenceCases(),
      headRevalidation: common.headRevalidation,
      locale: "en",
      opportunityId: common.opportunityId
    });
    const second = compileAttuneGraphPolicyCard({
      schemaVersion: 1,
      draft: {
        ...draft(),
        expectedBenefit: "Reduce interruption recovery time."
      },
      evidenceCases: evidenceCases(),
      headRevalidation: common.headRevalidation,
      locale: "en",
      opportunityId: common.opportunityId
    });

    expect(first.status).toBe("rendered");
    expect(second.status).toBe("rendered");
    if (first.status !== "rendered" || second.status !== "rendered") return;
    expect(first.card.cardId).not.toBe(second.card.cardId);
  });

  it("fails closed on copied mint, stale provider head, and replay tamper", async () => {
    const valid = await input();
    expect(compileAttuneGraphPolicyCard({
      ...valid,
      headRevalidation: JSON.parse(JSON.stringify(valid.headRevalidation))
    })).toEqual({ reason: "untrusted-revalidation", status: "held" });

    const changed = await fixture({ changed: true });
    expect(compileAttuneGraphPolicyCard({
      ...valid,
      headRevalidation: changed.headRevalidation,
      opportunityId: changed.opportunityId
    })).toEqual({ reason: "provider-not-fresh", status: "held" });

    const cases = evidenceCases();
    expect(compileAttuneGraphPolicyCard({
      ...valid,
      evidenceCases: [{
        ...cases[0],
        challenger: {
          ...cases[0]!.challenger,
          evidenceHash: "0".repeat(64)
        }
      }]
    })).toEqual({ reason: "replay-invalid", status: "held" });

    expect(compileAttuneGraphPolicyCard({
      ...valid,
      evidenceCases: [cases[0], structuredClone(cases[0])]
    })).toEqual({ reason: "replay-invalid", status: "held" });
  });

  it("settles the final byte budget before any post-budget finalizer", () => {
    const oversizedFinalizer = vi.fn(() => {
      throw new Error("must not run after an exceeded budget");
    });
    expect(settleAttuneGraphPolicyCardBudget(
      "x".repeat(POLICY_CARD_MAX_BYTES + 1),
      oversizedFinalizer
    )).toEqual({ status: "budget-exceeded" });
    expect(oversizedFinalizer).not.toHaveBeenCalled();

    const acceptedFinalizer = vi.fn(() => {
      throw new Error("/private/path must be reduced by the public boundary");
    });
    expect(() => settleAttuneGraphPolicyCardBudget(
      "{}",
      acceptedFinalizer
    )).toThrow("public boundary");
    expect(acceptedFinalizer).toHaveBeenCalledTimes(1);
  });

  it("rejects hostile input before any proxy trap or accessor runs", async () => {
    let traps = 0;
    const proxied = new Proxy(await input(), {
      get() {
        traps++;
        throw new Error("must not run");
      },
      getOwnPropertyDescriptor() {
        traps++;
        throw new Error("must not run");
      },
      getPrototypeOf() {
        traps++;
        throw new Error("must not run");
      },
      ownKeys() {
        traps++;
        throw new Error("must not run");
      }
    });
    expect(compileAttuneGraphPolicyCard(proxied)).toEqual({
      reason: "invalid-input",
      status: "held"
    });
    expect(traps).toBe(0);

    let getterRan = false;
    const accessor = Object.defineProperty({}, "schemaVersion", {
      enumerable: true,
      get() {
        getterRan = true;
        return 1;
      }
    });
    expect(compileAttuneGraphPolicyCard(accessor)).toEqual({
      reason: "invalid-input",
      status: "held"
    });
    expect(getterRan).toBe(false);
  });

  it("holds scope and temporal mismatches without leaking source content", async () => {
    const valid = await input();
    const scopeMismatch = compileAttuneGraphPolicyCard({
      ...valid,
      draft: {
        ...draft(),
        scope: { kind: "thread-timing", threadId: "thread_other" }
      }
    });
    const temporalMismatch = compileAttuneGraphPolicyCard({
      ...valid,
      draft: {
        ...draft(),
        proposedAt: "2026-07-31T09:04:00.000Z"
      }
    });

    expect(scopeMismatch).toEqual({ reason: "scope-mismatch", status: "held" });
    // Proposal validation precedes the later graph/time postcondition.
    expect(temporalMismatch).toEqual({ reason: "proposal-held", status: "held" });
    expect(JSON.stringify([scopeMismatch, temporalMismatch]))
      .not.toContain("Policy Card fixture");
  });

  it("maps every graph postcondition and both byte budgets to finite held reasons", async () => {
    const valid = await input();
    const expected = [
      ["invalid", "graph-invalid"],
      ["graph-scope", "graph-invalid"],
      ["missing", "graph-proof-missing"],
      ["ambiguous", "graph-proof-ambiguous"],
      ["temporal", "temporal-mismatch"],
      ["observation-time", "temporal-mismatch"],
      ["scoped-basis", "temporal-mismatch"],
      ["final-budget", "budget-exceeded"],
      ["throws-late", "internal-error"]
    ] as const;

    for (const [mode, reason] of expected) {
      observationDouble.mode = mode;
      expect(compileAttuneGraphPolicyCard(valid)).toEqual({
        reason,
        status: "held"
      });
    }

    observationDouble.mode = "normal";
    attunementDouble.throwQueue = true;
    expect(compileAttuneGraphPolicyCard(valid)).toEqual({
      reason: "internal-error",
      status: "held"
    });
    attunementDouble.throwQueue = false;
    expect(compileAttuneGraphPolicyCard({
      ...valid,
      draft: {
        ...draft(),
        proposedBehavior: "x".repeat(257 * 1024)
      }
    })).toEqual({ reason: "budget-exceeded", status: "held" });
  });

  it("keeps held-reason precedence stable across combined failures", async () => {
    const valid = await input();
    const stale = await fixture({ changed: true });
    const copied = JSON.parse(JSON.stringify(valid.headRevalidation));
    const missingOpportunity = `learning_opportunity_${"a".repeat(64)}`;
    const oversizedDraft = {
      ...draft(),
      proposedBehavior: "x".repeat(257 * 1024)
    };

    expect(compileAttuneGraphPolicyCard({
      ...valid,
      draft: oversizedDraft,
      locale: "fr"
    })).toEqual({ reason: "invalid-input", status: "held" });
    expect(compileAttuneGraphPolicyCard({
      ...valid,
      draft: oversizedDraft,
      headRevalidation: copied
    })).toEqual({ reason: "budget-exceeded", status: "held" });
    expect(compileAttuneGraphPolicyCard({
      ...valid,
      headRevalidation: JSON.parse(JSON.stringify(stale.headRevalidation)),
      opportunityId: stale.opportunityId
    })).toEqual({ reason: "untrusted-revalidation", status: "held" });
    expect(compileAttuneGraphPolicyCard({
      ...valid,
      headRevalidation: copied,
      opportunityId: missingOpportunity
    })).toEqual({ reason: "untrusted-revalidation", status: "held" });
    expect(compileAttuneGraphPolicyCard({
      ...valid,
      draft: {
        ...draft(),
        scope: { kind: "thread-timing", threadId: "thread_other" }
      },
      headRevalidation: stale.headRevalidation
    })).toEqual({ reason: "provider-not-fresh", status: "held" });
    expect(compileAttuneGraphPolicyCard({
      ...valid,
      draft: {
        ...draft(),
        scope: { kind: "thread-timing", threadId: "thread_other" }
      },
      opportunityId: missingOpportunity
    })).toEqual({ reason: "scope-mismatch", status: "held" });
    expect(compileAttuneGraphPolicyCard({
      ...valid,
      draft: {
        ...draft(),
        proposedAt: "2026-07-31T09:04:00.000Z"
      },
      evidenceCases: []
    })).toEqual({ reason: "proposal-held", status: "held" });
    expect(compileAttuneGraphPolicyCard({
      ...valid,
      draft: {
        ...draft(),
        proposedAt: "2026-07-31T09:04:00.000Z"
      },
      opportunityId: missingOpportunity
    })).toEqual({ reason: "opportunity-not-found", status: "held" });

    observationDouble.mode = "invalid";
    expect(compileAttuneGraphPolicyCard({
      ...valid,
      evidenceCases: []
    })).toEqual({ reason: "replay-invalid", status: "held" });

    for (const [mode, reason] of [
      ["invalid-missing", "graph-invalid"],
      ["missing-ambiguous", "graph-proof-missing"],
      ["ambiguous-temporal", "graph-proof-ambiguous"],
      ["temporal-budget", "temporal-mismatch"]
    ] as const) {
      observationDouble.mode = mode;
      expect(compileAttuneGraphPolicyCard(valid)).toEqual({
        reason,
        status: "held"
      });
    }
  });
});
