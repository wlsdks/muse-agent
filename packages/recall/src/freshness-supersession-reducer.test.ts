import { describe, expect, it } from "vitest";

import {
  FRESHNESS_SUPERSESSION_POLICY_V1,
  FRESHNESS_SUPERSESSION_MAX_LINKS_V1,
  FreshnessSupersessionInputError,
  reduceFreshnessSupersessionV1,
  type FreshnessCandidateV1,
  type FreshnessSupersessionInputV1
} from "./index.js";

const candidate = (
  identity: string,
  overrides: Partial<Omit<FreshnessCandidateV1, "identity">> = {}
): FreshnessCandidateV1 => ({
  confidence: 0.8,
  identity,
  observedAt: "2026-07-20T00:00:00.000Z",
  sourceAuthority: "user-authored",
  ...overrides
});

const input = (
  left: FreshnessCandidateV1,
  right: FreshnessCandidateV1,
  correctionLinks: FreshnessSupersessionInputV1["correctionLinks"] = []
): FreshnessSupersessionInputV1 => ({
  candidates: [left, right],
  correctionLinks,
  policyVersion: FRESHNESS_SUPERSESSION_POLICY_V1
});

const permutations = <T>(left: T, right: T): readonly (readonly [T, T])[] => [
  [left, right],
  [right, left]
];

describe("freshness supersession policy v1", () => {
  it("lets a verified explicit correction win over every weaker signal and deduplicates the link", () => {
    const current = candidate("fact-current", {
      confidence: 0.1,
      observedAt: "2026-07-01T00:00:00.000Z",
      sourceAuthority: "inferred"
    });
    const stale = candidate("fact-stale", {
      confidence: 1,
      observedAt: "2026-07-25T00:00:00.000Z",
      sourceAuthority: "user-authored"
    });
    for (const candidates of permutations(current, stale)) {
      const decision = reduceFreshnessSupersessionV1({
        candidates,
        correctionLinks: Array.from(
          { length: FRESHNESS_SUPERSESSION_MAX_LINKS_V1 },
          () => ({ currentIdentity: current.identity, staleIdentity: stale.identity, verification: "user-authored" as const })
        ),
        policyVersion: FRESHNESS_SUPERSESSION_POLICY_V1
      });
      expect(decision).toEqual({
        decisiveDimension: "explicit-correction",
        orderedIdentities: ["fact-current", "fact-stale"],
        policyVersion: FRESHNESS_SUPERSESSION_POLICY_V1,
        reason: "explicit-correction",
        schema: "muse.freshness-supersession-decision.v1",
        selectedIdentity: "fact-current",
        status: "selected"
      });
      expect(Object.isFrozen(decision)).toBe(true);
      expect(Object.isFrozen(decision.orderedIdentities)).toBe(true);
    }
  });

  it("prevents a newer high-confidence weak inference from overriding user-authored evidence", () => {
    const user = candidate("fact-user", {
      confidence: 0.2,
      observedAt: "2026-07-01T00:00:00.000Z"
    });
    const inferred = candidate("fact-inferred", {
      confidence: 1,
      observedAt: "2026-07-25T00:00:00.000Z",
      sourceAuthority: "inferred"
    });
    for (const candidates of permutations(user, inferred)) {
      const decision = reduceFreshnessSupersessionV1({ ...input(candidates[0], candidates[1]) });
      expect(decision.selectedIdentity).toBe("fact-user");
      expect(decision.reason).toBe("source-authority");
    }
  });

  it("uses confidence before timestamp within the same authority", () => {
    const olderStrong = candidate("fact-older-strong", {
      confidence: 1,
      observedAt: "2026-07-01T00:00:00.000Z",
      sourceAuthority: "inferred"
    });
    const newerWeak = candidate("fact-newer-weak", {
      confidence: 0,
      observedAt: "2026-07-25T00:00:00.000Z",
      sourceAuthority: "inferred"
    });
    for (const candidates of permutations(olderStrong, newerWeak)) {
      const decision = reduceFreshnessSupersessionV1(input(candidates[0], candidates[1]));
      expect(decision).toMatchObject({
        decisiveDimension: "confidence",
        selectedIdentity: "fact-older-strong",
        status: "selected"
      });
    }
  });

  it("uses canonical event time rather than import order within one authority", () => {
    const older = candidate("fact-older", { observedAt: "2026-07-20T00:00:00.000Z" });
    const newer = candidate("fact-newer", { observedAt: "2026-07-22T00:00:00.000Z" });
    for (const candidates of permutations(older, newer)) {
      const decision = reduceFreshnessSupersessionV1(input(candidates[0], candidates[1]));
      expect(decision.selectedIdentity).toBe("fact-newer");
      expect(decision.reason).toBe("event-time");
    }
  });

  it("uses confidence for otherwise equal evidence and leaves a complete tie unresolved", () => {
    const lower = candidate("fact-lower", { confidence: 0.4 });
    const higher = candidate("fact-higher", { confidence: 0.9 });
    for (const candidates of permutations(lower, higher)) {
      const decision = reduceFreshnessSupersessionV1(input(candidates[0], candidates[1]));
      expect(decision.selectedIdentity).toBe("fact-higher");
      expect(decision.reason).toBe("confidence");
    }

    const tieA = candidate("fact-a");
    const tieB = candidate("fact-b");
    const first = reduceFreshnessSupersessionV1(input(tieA, tieB));
    const second = reduceFreshnessSupersessionV1(input(tieB, tieA));
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      decisiveDimension: "none",
      orderedIdentities: ["fact-a", "fact-b"],
      reason: "complete-tie",
      selectedIdentity: null,
      status: "unresolved"
    });
  });

  it("fails closed for unknown versions, malformed evidence, and conflicting correction directions", () => {
    const left = candidate("fact-left");
    const right = candidate("fact-right");
    const invalidInputs: unknown[] = [
      { ...input(left, right), policyVersion: "muse.freshness-supersession-policy.v2" },
      input({ ...left, confidence: Number.NaN }, right),
      input({ ...left, observedAt: "2026-07-20" }, right),
      input({ ...left, sourceAuthority: "model" as never }, right),
      input(left, { ...right, identity: left.identity }),
      input(left, right, [{ currentIdentity: left.identity, staleIdentity: left.identity, verification: "user-authored" }]),
      input(left, right, [{ currentIdentity: left.identity, staleIdentity: "missing", verification: "user-authored" }]),
      input(left, right, [{ currentIdentity: left.identity, staleIdentity: right.identity, verification: "inferred" as never }]),
      input(left, right, [
        { currentIdentity: left.identity, staleIdentity: right.identity, verification: "user-authored" },
        { currentIdentity: right.identity, staleIdentity: left.identity, verification: "user-authored" }
      ]),
      input(left, right, Array.from(
        { length: FRESHNESS_SUPERSESSION_MAX_LINKS_V1 + 1 },
        () => ({ currentIdentity: left.identity, staleIdentity: right.identity, verification: "user-authored" as const })
      ))
    ];
    for (const invalidInput of invalidInputs) {
      expect(() => reduceFreshnessSupersessionV1(invalidInput as FreshnessSupersessionInputV1)).toThrow(FreshnessSupersessionInputError);
    }
  });

  it("rejects schema drift and numeric, timestamp, and identity boundary violations", () => {
    const left = candidate("fact-left");
    const right = candidate("fact-right");
    const valid = input(left, right);
    const validLink = {
      currentIdentity: left.identity,
      staleIdentity: right.identity,
      verification: "user-authored" as const
    };
    const invalidInputs: unknown[] = [
      { ...valid, extra: true },
      { candidates: valid.candidates, policyVersion: valid.policyVersion },
      { ...valid, candidates: "not-an-array" },
      { ...valid, correctionLinks: "not-an-array" },
      { ...valid, candidates: [{ ...left, extra: true }, right] },
      { ...valid, candidates: [{ confidence: left.confidence, identity: left.identity, observedAt: left.observedAt }, right] },
      { ...valid, correctionLinks: [{ ...validLink, extra: true }] },
      { ...valid, correctionLinks: [{ currentIdentity: left.identity, staleIdentity: right.identity }] },
      input({ ...left, confidence: Number.POSITIVE_INFINITY }, right),
      input({ ...left, confidence: Number.NEGATIVE_INFINITY }, right),
      input({ ...left, confidence: -0.01 }, right),
      input({ ...left, confidence: 1.01 }, right),
      input({ ...left, observedAt: "2026-02-30T00:00:00.000Z" }, right),
      input({ ...left, observedAt: "2026-07-20T09:00:00+09:00" }, right),
      input({ ...left, observedAt: "2026-07-20T00:00:00Z" }, right),
      input({ ...left, identity: "" }, right),
      input({ ...left, identity: "Fact-Uppercase" }, right),
      input({ ...left, identity: `f${"a".repeat(128)}` }, right)
    ];
    for (const invalidInput of invalidInputs) {
      expect(() => reduceFreshnessSupersessionV1(invalidInput as FreshnessSupersessionInputV1)).toThrow(FreshnessSupersessionInputError);
    }

    const zero = candidate("fact-zero", { confidence: 0 });
    const one = candidate("fact-one", { confidence: 1 });
    for (const candidates of permutations(zero, one)) {
      expect(reduceFreshnessSupersessionV1(input(candidates[0], candidates[1]))).toMatchObject({
        reason: "confidence",
        selectedIdentity: "fact-one",
        status: "selected"
      });
    }
  });

  it("accepts only exact own enumerable data and normalizes hostile objects to the fixed public error", () => {
    const left = candidate("fact-left");
    const right = candidate("fact-right");
    let getterCalls = 0;
    const accessorCandidate = {};
    for (const [key, value] of Object.entries(left)) {
      Object.defineProperty(accessorCandidate, key, {
        enumerable: true,
        get: () => {
          getterCalls += 1;
          return value;
        }
      });
    }
    const hiddenExtra = { ...left };
    Object.defineProperty(hiddenExtra, "hidden", { enumerable: false, value: true });
    const symbolExtra = { ...left, [Symbol("extra")]: true };
    const sparseCandidates = new Array(2);
    sparseCandidates[0] = left;
    const candidatesWithExtra = [left, right] as FreshnessCandidateV1[] & { extra?: boolean };
    candidatesWithExtra.extra = true;
    const hostileTopLevel = new Proxy(input(left, right), {
      ownKeys: () => {
        throw new Error("trap-ran");
      }
    });
    const invalidInputs: unknown[] = [
      input(accessorCandidate as FreshnessCandidateV1, right),
      input(hiddenExtra, right),
      input(symbolExtra, right),
      { ...input(left, right), candidates: sparseCandidates },
      { ...input(left, right), candidates: candidatesWithExtra },
      hostileTopLevel
    ];
    for (const invalidInput of invalidInputs) {
      let error: unknown;
      try {
        reduceFreshnessSupersessionV1(invalidInput as FreshnessSupersessionInputV1);
      } catch (cause) {
        error = cause;
      }
      expect(error).toBeInstanceOf(FreshnessSupersessionInputError);
      expect(error).toMatchObject({
        code: "RECALL_FRESHNESS_INPUT_INVALID",
        message: "Freshness supersession input is invalid.",
        name: "FreshnessSupersessionInputError",
        stack: "FreshnessSupersessionInputError: Freshness supersession input is invalid."
      });
    }
    expect(getterCalls).toBe(0);
  });
});
