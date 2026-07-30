import { describe, expect, it } from "vitest";

import type { GraphAssertion, GraphRef } from "@attunegraph/core";
import {
  buildContinuityPathTree,
  classifyContinuityTemporal,
  explainContinuityPath,
  isContinuityNoOp
} from "./continuity-change-semantics.js";

const SOURCE = Object.freeze({
  id: "source",
  namespace: "muse.test",
  version: "v1"
});
const RECORDED = "2026-07-29T09:00:00.000Z";
const BOUNDARY = "2026-07-29T08:00:00.000Z";
const CURRENT = "2026-07-29T10:00:00.000Z";

function assertion(
  id: string,
  subject: GraphRef,
  object: GraphRef,
  overrides: Partial<GraphAssertion> = {}
): GraphAssertion {
  return {
    schemaVersion: 1,
    id,
    derivation: { kind: "projection", version: "test-v1" },
    epistemicClass: "source-observed",
    object,
    predicate: "LINKED_TO",
    recordedAt: RECORDED,
    sourceRefs: [SOURCE],
    subject,
    validFrom: RECORDED,
    ...overrides
  };
}

describe("Continuity change shared semantics", () => {
  it("covers the temporal truth table exhaustively", () => {
    const thread = { id: "thread", kind: "thread" } as const;
    const artifact = { id: "artifact", kind: "artifact" } as const;
    const classify = (overrides: Partial<GraphAssertion>) =>
      classifyContinuityTemporal(
        assertion("change", artifact, thread, overrides),
        BOUNDARY,
        CURRENT
      );

    expect(classify({
      recordedAt: "2026-07-29T08:30:00.000Z",
      validFrom: "2026-07-29T08:30:00.000Z"
    })).toBe("world-valid");
    expect(classify({
      recordedAt: "2026-07-29T09:00:00.000Z",
      validFrom: BOUNDARY
    })).toBeUndefined();
    expect(classify({
      recordedAt: "2026-07-29T09:00:00.000Z",
      validFrom: "2026-07-29T07:00:00.000Z"
    })).toBeUndefined();
    expect(classify({
      recordedAt: "2026-07-29T09:00:00.000Z",
      validFrom: "2026-07-29T11:00:00.000Z"
    })).toBe("learned-after");
    expect(classify({
      recordedAt: "2026-07-29T09:00:00.000Z",
      validFrom: undefined
    })).toBe("learned-after");
    expect(classify({
      recordedAt: BOUNDARY,
      validFrom: undefined
    })).toBeUndefined();
    expect(classify({
      recordedAt: "2026-07-29T11:00:00.000Z",
      validFrom: "2026-07-29T11:00:00.000Z"
    })).toBeUndefined();
  });

  it("uses source identity—not observation-derived projection identity—for no-op replay", () => {
    expect(isContinuityNoOp(
      { sourceVersion: "same" },
      { sourceVersion: "same" }
    )).toBe(true);
    expect(isContinuityNoOp(
      { sourceVersion: "before" },
      { sourceVersion: "after" }
    )).toBe(false);
  });

  it("selects the same lexicographic shortest path after input reorder", () => {
    const seed = { id: "seed", kind: "thread" } as const;
    const left = { id: "left", kind: "artifact" } as const;
    const right = { id: "right", kind: "artifact" } as const;
    const terminal = { id: "terminal", kind: "artifact" } as const;
    const changedObject = { id: "changed", kind: "evidence" } as const;
    const support = [
      assertion("a-first", seed, left),
      assertion("z-second", left, terminal),
      assertion("b-first", seed, right),
      assertion("a-second", right, terminal)
    ];
    const changed = assertion("changed-edge", terminal, changedObject);
    const forward = explainContinuityPath(
      changed,
      buildContinuityPathTree(seed, support)
    );
    const reverse = explainContinuityPath(
      changed,
      buildContinuityPathTree(seed, [...support].reverse())
    );

    expect(forward?.map((step) => step.assertionId))
      .toEqual(["a-first", "z-second", "changed-edge"]);
    expect(reverse).toEqual(forward);
  });

  it("includes support depth three and excludes terminals beyond the declared domain", () => {
    const refs = Array.from({ length: 6 }, (_, index) => ({
      id: `ref_${index.toString()}`,
      kind: index === 0 ? "thread" as const : "artifact" as const
    }));
    const support = [
      assertion("edge_1", refs[0]!, refs[1]!),
      assertion("edge_2", refs[1]!, refs[2]!),
      assertion("edge_3", refs[2]!, refs[3]!),
      assertion("edge_4", refs[3]!, refs[4]!)
    ];
    const tree = buildContinuityPathTree(refs[0]!, support);
    const atDepthThree = assertion("changed_3", refs[3]!, refs[5]!);
    const beyondDepth = assertion("changed_4", refs[4]!, refs[5]!);

    expect(explainContinuityPath(atDepthThree, tree)?.map((step) => step.assertionId))
      .toEqual(["edge_1", "edge_2", "edge_3", "changed_3"]);
    expect(explainContinuityPath(beyondDepth, tree)).toBeUndefined();
    expect(tree.maxDepthReached).toBe(3);
    expect(tree.truncated).toBe(false);
  });
});
