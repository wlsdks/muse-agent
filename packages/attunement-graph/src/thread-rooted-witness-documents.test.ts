import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  CANONICAL_IMMUTABLE_ENVELOPE_LIMITS,
  canonicalizeImmutableEnvelope
} from "./canonical-immutable-envelope.js";
import {
  ThreadRootedWitnessDocumentsError,
  compileThreadRootedWitnessDocuments,
  getThreadRootedRetainedWitnessInventory
} from "./thread-rooted-witness-documents.js";
import type { GraphAssertion, GraphPredicate, GraphRef } from "./types.js";

const NOW = "2026-07-29T10:00:00.000Z";
const SCOPE = { sourceId: "dogfood", threadId: "thread-1" };
const THREAD = { id: SCOPE.threadId, kind: "thread" } as const;
const A = { id: "artifact-a", kind: "artifact" } as const;
const B = { id: "artifact-b", kind: "artifact" } as const;
const C = { id: "artifact-c", kind: "artifact" } as const;
const D = { id: "artifact-d", kind: "artifact" } as const;
const SNAPSHOT = {
  authority: "caller-declared-read-snapshot",
  commitHash: `sha256:${"a".repeat(64)}`,
  commitSequence: 7,
  generationId: "generation-7"
} as const;
const PROVIDER_SNAPSHOT = {
  authority: "receipt-integrity-only",
  kind: "process-local-provider-capture",
  providerReceiptId: `muse-local-attunement-snapshot:sha256:${"b".repeat(64)}`,
  providerId: "muse.local-attunement-store",
  providerVersion: "muse.local-attunement-snapshot-provider.v1",
  stateDigest: `sha256:${"c".repeat(64)}`,
  normalizedStateBytes: 42,
  captureCompletedAt: NOW,
  mintVerification: "verified-in-composing-process",
  mintVerificationSurvivesSerialization: false
} as const;
const HEAD_REVALIDATION_RECEIPT_ID =
  `muse-local-attunement-head-revalidation:sha256:${"d".repeat(64)}`;
const HEAD_PROVIDER_SCOPE = { ...SCOPE };
const HEAD_ENDPOINT = {
  providerReceiptId:
    `muse-local-attunement-snapshot:sha256:${"e".repeat(64)}`,
  stateDigest: `sha256:${"f".repeat(64)}`,
  normalizedStateBytes: 42,
  captureCompletedAt: NOW
};
const HEAD_SNAPSHOT = {
  authority: "receipt-integrity-only",
  kind: "process-local-provider-head-revalidation",
  revalidationReceiptId: HEAD_REVALIDATION_RECEIPT_ID,
  providerId: "muse.local-attunement-store",
  providerVersion: "muse.local-attunement-snapshot-provider.v1",
  providerScope: HEAD_PROVIDER_SCOPE,
  subject: HEAD_ENDPOINT,
  head: {
    ...HEAD_ENDPOINT,
    providerReceiptId:
      `muse-local-attunement-snapshot:sha256:${"1".repeat(64)}`
  },
  mintVerification:
    "provider-owned-two-capture-pair-verified-in-composing-process",
  mintVerificationSurvivesSerialization: false
} as const;
const HEAD_FRESHNESS = {
  basis: "provider-head-revalidation",
  status: "fresh",
  providerScope: HEAD_PROVIDER_SCOPE,
  observedAt: NOW,
  assessedAt: NOW,
  captureSpanMs: 0,
  maxCaptureSpanMs: 25,
  reasonId: "head-state-matched-within-bound",
  revalidationReceiptId: HEAD_REVALIDATION_RECEIPT_ID
} as const;

function assertion(
  id: string,
  subject: GraphRef,
  predicate: GraphPredicate,
  object: GraphRef,
  overrides: Partial<GraphAssertion> = {}
): GraphAssertion {
  return {
    schemaVersion: 1,
    id,
    subject,
    predicate,
    object,
    epistemicClass: "source-observed",
    sourceRefs: [{ id: `source-${id}`, namespace: "dogfood" }],
    recordedAt: "2026-07-29T09:00:00.000Z",
    derivation: { kind: "projection", version: "fixture-v1" },
    ...overrides
  };
}

const EDGE_A = assertion("edge-a", A, "LINKED_TO", THREAD);
const EDGE_B = assertion("edge-b", A, "REVISION_OF", B);

function scoped(item: GraphAssertion, memberships = [SCOPE]) {
  return JSON.parse(JSON.stringify({ assertion: item, memberships })) as {
    assertion: GraphAssertion;
    memberships: typeof SCOPE[];
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return JSON.parse(JSON.stringify({
    schemaVersion: 1,
    operatorVersion: "muse.thread-rooted-witness-documents.v1",
    scope: structuredClone(SCOPE),
    snapshot: structuredClone(SNAPSHOT),
    declaredFreshness: {
      assessedAt: NOW,
      observedAt: NOW,
      status: "fresh"
    },
    query: {
      seeds: [structuredClone(THREAD)],
      predicates: ["LINKED_TO", "REVISION_OF"],
      direction: "both",
      maxDepth: 4,
      maxAssertions: 16,
      maxConsideredAssertions: 32,
      maxVisitedRefs: 16,
      validAt: NOW,
      recordedAtOrBefore: NOW
    },
    boundedResult: {
      assertions: [scoped(EDGE_A), scoped(EDGE_B)],
      refs: [structuredClone(THREAD), structuredClone(A), structuredClone(B)],
      diagnostics: {
        consideredAssertions: 2,
        maxDepthReached: 2,
        visitedRefs: 3
      },
      truncated: false
    },
    nominations: {
      core: {
        assertionId: EDGE_A.id,
        kind: "core",
        nominationId: "core-context",
        observedAt: NOW
      },
      optionals: [{
        assertionId: EDGE_B.id,
        kind: "change",
        nominationId: "changed-flight",
        observedAt: NOW
      }]
    },
    budget: {
      maxAssertions: 64,
      maxConsideredAssertions: 256,
      maxDepth: 12,
      maxEstimatedTokens: 32_768,
      maxOutputBytes: 1_000_000,
      maxVisitedRefs: 128
    },
    ...overrides
  })) as {
    schemaVersion: number;
    operatorVersion: string;
    requestId?: string;
    scope: typeof SCOPE;
    snapshot: {
      authority: "caller-declared-read-snapshot";
      commitHash: string;
      commitSequence: number;
      generationId: string;
    };
    declaredFreshness: { assessedAt: string; observedAt: string; status: string };
    query: {
      seeds: { id: string; kind: "thread" }[];
      predicates: GraphPredicate[];
      direction: "both" | "incoming" | "outgoing";
      maxDepth: number;
      maxAssertions: number;
      maxConsideredAssertions: number;
      maxVisitedRefs: number;
      validAt: string;
      recordedAtOrBefore: string;
      includeSuperseded?: boolean;
    };
    boundedResult: {
      assertions: { assertion: GraphAssertion; memberships: typeof SCOPE[] }[];
      refs: GraphRef[];
      diagnostics: {
        consideredAssertions: number;
        maxDepthReached: number;
        visitedRefs: number;
      };
      truncated: boolean;
    };
    nominations: {
      core: {
        assertionId: string;
        kind: "core";
        nominationId: string;
        observedAt: string;
      };
      optionals: {
        assertionId: string;
        kind: "change" | "support";
        nominationId: string;
        observedAt: string;
      }[];
    };
    budget: {
      maxAssertions: number;
      maxConsideredAssertions: number;
      maxDepth: number;
      maxEstimatedTokens: number;
      maxOutputBytes: number;
      maxVisitedRefs: number;
    };
  };
}

function copy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item)).join(",")}]`;
  }
  const root = value as Record<string, unknown>;
  return `{${Object.keys(root).sort().map((key) =>
    `${JSON.stringify(key)}:${canonical(root[key])}`
  ).join(",")}}`;
}

function independentId(
  value: unknown,
  idField: string,
  hashDomain: string,
  idPrefix: string
): string {
  const body = copy(value) as Record<string, unknown>;
  delete body[idField];
  return `${idPrefix}${createHash("sha256")
    .update(hashDomain, "utf8")
    .update("\0", "utf8")
    .update(canonical(body), "utf8")
    .digest("hex")}`;
}

function expectDeepFrozen(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object" || seen.has(value)) return;
  seen.add(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor && key !== "length") {
      expectDeepFrozen(descriptor.value, seen);
    }
  }
}

function compileOrExplain(value: unknown) {
  try {
    return compileThreadRootedWitnessDocuments(value);
  } catch (cause) {
    if (cause instanceof ThreadRootedWitnessDocumentsError) {
      throw new Error(JSON.stringify(cause.details), { cause });
    }
    throw cause;
  }
}

describe("compileThreadRootedWitnessDocuments", () => {
  it("rejects cross-scope provider-head replay at direct entry", () => {
    try {
      compileThreadRootedWitnessDocuments(request({
        scope: { ...SCOPE, threadId: "thread-other" },
        snapshot: HEAD_SNAPSHOT,
        declaredFreshness: HEAD_FRESHNESS
      }));
    } catch (cause) {
      expect(cause).toBeInstanceOf(ThreadRootedWitnessDocumentsError);
      expect((cause as ThreadRootedWitnessDocumentsError).details).toEqual({
        path: "/scope",
        reason: "snapshot-freshness-mismatch"
      });
      return;
    }
    throw new Error("expected cross-scope rejection");
  });

  it("forces settlement abstention for an unassessed provider capture without inventing graph commits", () => {
    const result = compileThreadRootedWitnessDocuments({
      ...request(),
      snapshot: PROVIDER_SNAPSHOT,
      declaredFreshness: {
        status: "unassessed",
        reasonId: "single-read-no-head-revalidation"
      }
    });
    expect(result.status).toBe("abstained");
    expect(result.receipt.coverage.reasons.slice(0, 3)).toEqual([
      "provider-capture-snapshot-integrity-only",
      "freshness-unassessed",
      "bounded-result-only"
    ]);
    expect(result.settlement?.status).toBe("abstained");
    expect(result.settlement).toMatchObject({
      completeness: { reasons: ["freshness-unassessed", "mandatory-proof-not-admitted", "settlement-abstained"] }
    });
  });

  it("builds exact thread-rooted proof documents and delegates settlement once", () => {
    const input = request();
    (input.boundedResult.assertions[1]!.assertion as unknown as {
      sourceRefs: { id: string; namespace: string }[];
    }).sourceRefs = [
      { id: "a", namespace: "dogfood" },
      { id: "z", namespace: "dogfood" }
    ];
    const result = compileThreadRootedWitnessDocuments(input);
    expect(result.status).toBe("partial");
    expect(result.receipt.coverage).toEqual({
      canAssertAbsenceWithinSnapshot: false,
      canAssertCurrentWorldAbsence: false,
      reasons: ["caller-declared-snapshot", "bounded-result-only"],
      status: "partial"
    });
    expect(result.receipt.dispositions).toEqual([
      expect.objectContaining({
        assertionId: "edge-a",
        nominationId: "core-context",
        role: "core",
        status: "witnessed"
      }),
      expect.objectContaining({
        assertionId: "edge-b",
        nominationId: "changed-flight",
        role: "optional",
        status: "witnessed"
      })
    ]);
    expect(result.settlement?.status).toBe("partial");
    expect(result.frontier?.receipt.dispositions).toEqual([
      expect.objectContaining({
        focusAssertionId: "edge-b",
        lane: "change",
        nominationId: "changed-flight",
        predicate: "REVISION_OF",
        rank: 0,
        status: "budget-admitted"
      })
    ]);
    expect(result.frontier?.receipt.coverage).toEqual({
      canAssertAbsenceWithinSnapshot: false,
      canAssertCurrentWorldAbsence: false,
      reasons: [
        "bounded-witness-pool-only",
        "caller-declared-snapshot",
        "caller-declared-freshness",
        "source-authority-not-independently-verified",
        "focus-predicate-lane-mapping-v1"
      ],
      status: "partial"
    });
    expect(result.receipt.frontierReceiptId).toBe(
      result.frontier?.receipt.receiptId
    );
    if (result.settlement?.status !== "partial") throw new Error("expected partial");
    const documents = new Map(result.settlement.documents.map((item) => [item.kind, item]));
    expect(documents.get("core")?.proof.paths).toEqual([[
      { assertionId: "edge-a", direction: "incoming" }
    ]]);
    expect(documents.get("change")?.proof.paths).toEqual([[
      { assertionId: "edge-a", direction: "incoming" },
      { assertionId: "edge-b", direction: "outgoing" }
    ]]);
    expect(documents.get("change")?.proof.assertions.map((item) =>
      item.memberships
    )).toEqual([[SCOPE], [SCOPE]]);
    expect(documents.get("change")?.proof.sourceRefs).toEqual([
      { id: "a", namespace: "dogfood" },
      { id: "source-edge-a", namespace: "dogfood" },
      { id: "z", namespace: "dogfood" }
    ]);
    expect(result.receipt.settlementResultId).toBe(result.settlement.resultId);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.receipt.dispositions)).toBe(true);
    const retainedId = result.receipt.receiptId;
    input.scope.threadId = "mutated";
    expect(result.receipt.scope.threadId).toBe("thread-1");
    expect(result.receipt.receiptId).toBe(retainedId);
    expect(() => {
      (result.receipt.dispositions as unknown as unknown[]).push({});
    }).toThrow();
  });

  it("retains witnesses only for the exact compilation identity without changing serialization", () => {
    const result = compileThreadRootedWitnessDocuments(request());
    const keys = ["frontier", "receipt", "settlement", "status"];
    const expectedJson = JSON.stringify({
      frontier: result.frontier,
      receipt: result.receipt,
      settlement: result.settlement,
      status: result.status
    });

    expect(Object.keys(result)).toEqual(keys);
    expect({ ...result }).toEqual({
      frontier: result.frontier,
      receipt: result.receipt,
      settlement: result.settlement,
      status: result.status
    });
    expect(JSON.stringify(result)).toBe(expectedJson);

    const inventory = getThreadRootedRetainedWitnessInventory(result);
    expect(inventory?.registry.core.entry).toMatchObject({
      assertionId: "edge-a",
      nominationId: "core-context",
      role: "core"
    });
    expect(inventory?.registry.optionals).toHaveLength(1);
    expect(inventory?.registry.optionals[0]?.entry).toMatchObject({
      assertionId: "edge-b",
      nominationId: "changed-flight",
      role: "optional"
    });
    expect(getThreadRootedRetainedWitnessInventory({ ...result })).toBeUndefined();
    expect(
      getThreadRootedRetainedWitnessInventory(JSON.parse(JSON.stringify(result)))
    ).toBeUndefined();
    expect(
      getThreadRootedRetainedWitnessInventory(new Proxy(result, {}))
    ).toBeUndefined();

    const enclosing = { legacyCompilation: result, marker: "unchanged" };
    expect(Object.keys(enclosing)).toEqual(["legacyCompilation", "marker"]);
    expect({ ...enclosing }).toEqual({
      legacyCompilation: result,
      marker: "unchanged"
    });
    expect(JSON.stringify(enclosing)).toBe(JSON.stringify({
      legacyCompilation: {
        frontier: result.frontier,
        receipt: result.receipt,
        settlement: result.settlement,
        status: result.status
      },
      marker: "unchanged"
    }));
    expect(JSON.stringify(enclosing)).not.toContain("retained-witness");
  });

  it("content-addresses distinct core and optional entries plus a compact manifest", () => {
    const input = request();
    const inputBefore = copy(input);
    const result = compileThreadRootedWitnessDocuments(input);
    const inventory = getThreadRootedRetainedWitnessInventory(result);
    if (!inventory) throw new Error("expected retained inventory");
    const { core, optionals } = inventory.registry;
    const optional = optionals[0];
    if (!optional) throw new Error("expected retained optional");

    expect(Object.keys(core.entry).sort()).toEqual([
      "assertionId",
      "candidateId",
      "documentId",
      "entryId",
      "entryVersion",
      "focusAssertionDigest",
      "focusAssertionId",
      "frontierCore",
      "nominationId",
      "observedAt",
      "role",
      "schemaVersion"
    ]);
    expect(Object.keys(optional.entry).sort()).toEqual([
      "assertionId",
      "candidateId",
      "documentId",
      "entryId",
      "entryVersion",
      "focusAssertionDigest",
      "focusAssertionId",
      "frontierDisposition",
      "nominationId",
      "observedAt",
      "role",
      "schemaVersion"
    ]);
    expect(core.entry.frontierCore).toEqual({
      candidateId: result.frontier?.receipt.coreCandidateId,
      documentId: result.frontier?.receipt.coreDocumentId
    });
    expect(optional.entry.frontierDisposition).toEqual(
      result.frontier?.receipt.dispositions[0]
    );
    expect(core.entry.entryId).toBe(independentId(
      core.entry,
      "entryId",
      "muse.attunement-graph.thread-rooted-retained-witness-entry.v1",
      "muse-thread-rooted-retained-witness-entry:sha256:"
    ));
    expect(optional.entry.entryId).toBe(independentId(
      optional.entry,
      "entryId",
      "muse.attunement-graph.thread-rooted-retained-witness-entry.v1",
      "muse-thread-rooted-retained-witness-entry:sha256:"
    ));
    expect(inventory.manifest.manifestId).toBe(independentId(
      inventory.manifest,
      "manifestId",
      "muse.attunement-graph.thread-rooted-retained-witness-manifest.v1",
      "muse-thread-rooted-retained-witness-manifest:sha256:"
    ));
    expect(inventory.manifest).not.toHaveProperty("document");
    expect(inventory.manifest).not.toHaveProperty("focusAssertion");
    expect(canonical(input)).toBe(canonical(inputBefore));
    expectDeepFrozen(inventory);
    expect(() => {
      (inventory.registry.optionals as unknown as unknown[]).push({});
    }).toThrow();
  });

  it("keeps all five fair lanes and partitions ranked versus lane-undetermined entries", () => {
    const value = request();
    const decision = { id: "policy-decision", kind: "decision" } as const;
    const action = { id: "authority-action", kind: "action" } as const;
    const lanes: readonly [GraphPredicate, GraphRef, GraphRef, string][] = [
      ["PRECEDED", A, { id: "continuity-target", kind: "artifact" }, "continuity"],
      ["REVISION_OF", A, { id: "change-target", kind: "artifact" }, "change"],
      ["SUPPORTED_BY", A, { id: "evidence-target", kind: "evidence" }, "evidence"],
      ["PROPOSES_POLICY", decision, { id: "policy-target", kind: "policy" }, "policy"],
      ["AUTHORIZED_BY", action, { id: "authority-target", kind: "evidence" }, "authority"]
    ];
    const laneAssertions = lanes.map(([predicate, subject, object, lane]) =>
      assertion(`lane-${lane}`, subject, predicate, object)
    );
    const bridges = [
      assertion("bridge-policy", A, "CORRELATES_WITH", decision),
      assertion("bridge-authority", A, "CORRELATES_WITH", action)
    ];
    const undetermined = assertion(
      "lane-undetermined",
      A,
      "LINKED_TO",
      THREAD
    );
    const allOptionals = [...laneAssertions, undetermined];
    value.boundedResult.assertions = [
      scoped(EDGE_A),
      ...bridges.map((item) => scoped(item)),
      ...allOptionals.map((item) => scoped(item))
    ];
    value.boundedResult.refs = copy([
      THREAD,
      A,
      decision,
      action,
      ...laneAssertions.map((item) => item.object)
    ]);
    value.boundedResult.diagnostics = {
      consideredAssertions: value.boundedResult.assertions.length,
      maxDepthReached: 2,
      visitedRefs: value.boundedResult.refs.length
    };
    value.query.predicates = [...new Set([
      ...allOptionals.map((item) => item.predicate),
      "CORRELATES_WITH" as const
    ])];
    value.nominations.optionals = allOptionals.map((item, index) => ({
      assertionId: item.id,
      kind: index === 1 ? "change" : "support",
      nominationId: `nomination-${item.id}`,
      observedAt: NOW
    }));

    const result = compileOrExplain(value);
    const inventory = getThreadRootedRetainedWitnessInventory(result);
    if (!inventory || !result.frontier) throw new Error("expected inventory");
    expect(new Set(result.frontier.receipt.dispositions.flatMap((item) =>
      "lane" in item ? [item.lane] : []
    ))).toEqual(new Set(lanes.map(([, , , lane]) => lane)));
    const entriesById = new Map(inventory.registry.optionals.map((item) => [
      item.entry.entryId,
      item.entry
    ]));
    expect(inventory.manifest.fairOrderedOptionalEntryIds.map((id) =>
      entriesById.get(id)?.frontierDisposition.status
    )).toEqual(result.frontier.order.entries.map((entry) =>
      result.frontier?.receipt.dispositions.find((item) =>
        item.candidateId === entry.candidateId
      )?.status
    ));
    expect(inventory.manifest.laneUndeterminedEntryIds.map((id) =>
      entriesById.get(id)?.nominationId
    )).toEqual(["nomination-lane-undetermined"]);

    const permuted = copy(value);
    permuted.boundedResult.assertions.reverse();
    permuted.boundedResult.refs.reverse();
    permuted.nominations.optionals.reverse();
    const second = compileOrExplain(permuted);
    const secondInventory = getThreadRootedRetainedWitnessInventory(second);
    expect(secondInventory?.manifest.manifestId).toBe(
      inventory.manifest.manifestId
    );
    expect(secondInventory?.registry.optionals.map((item) => item.entry.entryId))
      .toEqual(inventory.registry.optionals.map((item) => item.entry.entryId));
  });

  it("retains every frontier disposition including capacity exclusions", () => {
    const statuses = new Map<string, string>();

    const admitted = compileOrExplain(request());
    statuses.set(
      "budget-admitted",
      getThreadRootedRetainedWitnessInventory(admitted)
        ?.registry.optionals[0]?.entry.frontierDisposition.status ?? ""
    );

    const undeterminedInput = request();
    undeterminedInput.boundedResult.assertions[1]!.assertion = assertion(
      "edge-b",
      A,
      "LINKED_TO",
      THREAD
    );
    undeterminedInput.boundedResult.refs = copy([THREAD, A]);
    undeterminedInput.boundedResult.diagnostics.visitedRefs = 2;
    const undetermined = compileOrExplain(undeterminedInput);
    statuses.set(
      "lane-undetermined",
      getThreadRootedRetainedWitnessInventory(undetermined)
        ?.registry.optionals[0]?.entry.frontierDisposition.status ?? ""
    );

    const excludedInput = request();
    excludedInput.budget.maxAssertions = 2;
    const excluded = compileOrExplain(excludedInput);
    const excludedInventory =
      getThreadRootedRetainedWitnessInventory(excluded);
    if (!excludedInventory) throw new Error("expected excluded inventory");
    statuses.set(
      "capacity-excluded",
      excludedInventory.registry.optionals[0]
        ?.entry.frontierDisposition.status ?? ""
    );
    expect(excludedInventory.manifest.fairOrderedOptionalEntryIds).toEqual([
      excludedInventory.registry.optionals[0]?.entry.entryId
    ]);

    const unavailable = request();
    unavailable.declaredFreshness = {
      reasonId: "caller-unavailable",
      status: "unavailable"
    } as never;
    const coreNotAdmitted =
      compileOrExplain(unavailable);
    statuses.set(
      "core-not-admitted",
      getThreadRootedRetainedWitnessInventory(coreNotAdmitted)
        ?.registry.optionals[0]?.entry.frontierDisposition.status ?? ""
    );

    const invalidInput = request();
    invalidInput.budget.maxEstimatedTokens = 0;
    invalidInput.budget.maxOutputBytes = 0;
    const capacityInvalid =
      compileOrExplain(invalidInput);
    statuses.set(
      "capacity-invalid",
      getThreadRootedRetainedWitnessInventory(capacityInvalid)
        ?.registry.optionals[0]?.entry.frontierDisposition.status ?? ""
    );

    expect(statuses).toEqual(new Map([
      ["budget-admitted", "budget-admitted"],
      ["lane-undetermined", "lane-undetermined"],
      ["capacity-excluded", "capacity-excluded"],
      ["core-not-admitted", "core-not-admitted"],
      ["capacity-invalid", "capacity-invalid"]
    ]));
  });

  it("digests focus assertion bodies independently of assertion IDs", () => {
    const first = compileOrExplain(request());
    const changed = request();
    changed.boundedResult.assertions[1]!.assertion = assertion(
      EDGE_B.id,
      A,
      "REVISION_OF",
      C
    );
    changed.boundedResult.refs = copy([THREAD, A, C]);
    const second = compileOrExplain(changed);
    const firstEntry = getThreadRootedRetainedWitnessInventory(first)
      ?.registry.optionals[0]?.entry;
    const secondEntry = getThreadRootedRetainedWitnessInventory(second)
      ?.registry.optionals[0]?.entry;
    expect(firstEntry?.assertionId).toBe(secondEntry?.assertionId);
    expect(firstEntry?.focusAssertionDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(secondEntry?.focusAssertionDigest).not.toBe(
      firstEntry?.focusAssertionDigest
    );
  });

  it("keeps 255 retained entries and the compact manifest within exact canonical byte limits", () => {
    const value = request();
    const multibyte = "😀";
    const longAssertionId = multibyte.repeat(512);
    const optionalAssertions = Array.from({ length: 255 }, (_, index) =>
      assertion(
        index === 0 ? longAssertionId : `edge-${index.toString().padStart(3, "0")}`,
        THREAD,
        "PRECEDED",
        { id: `artifact-${index.toString().padStart(3, "0")}`, kind: "artifact" },
        index === 0
          ? { sourceRefs: [{ id: "source-long", namespace: "dogfood" }] }
          : {}
      )
    );
    value.boundedResult.assertions = copy([
      scoped(EDGE_A),
      ...optionalAssertions.map((item) => scoped(item))
    ]);
    value.boundedResult.refs = copy([
      THREAD,
      A,
      ...optionalAssertions.map((item) => item.object)
    ]);
    value.boundedResult.diagnostics = {
      consideredAssertions: 256,
      maxDepthReached: 1,
      visitedRefs: 257
    };
    value.query.predicates = ["LINKED_TO", "PRECEDED"];
    value.query.maxAssertions = 256;
    value.query.maxConsideredAssertions = 256;
    value.query.maxDepth = 2;
    value.query.maxVisitedRefs = 512;
    value.nominations.core.nominationId = `${multibyte.repeat(508)}core`;
    value.nominations.optionals = optionalAssertions.map((item, index) => ({
      assertionId: item.id,
      kind: "support",
      nominationId:
        `${multibyte.repeat(508)}${index.toString().padStart(4, "0")}`,
      observedAt: NOW
    }));
    value.budget.maxAssertions = 512;
    value.budget.maxConsideredAssertions = 1024;
    value.budget.maxDepth = 12;
    value.budget.maxEstimatedTokens = 0;
    value.budget.maxOutputBytes = 0;
    value.budget.maxVisitedRefs = 1024;

    expect(Array.from(value.nominations.optionals[0]!.nominationId)).toHaveLength(512);
    expect(Buffer.byteLength(
      value.nominations.optionals[0]!.nominationId,
      "utf8"
    )).toBeGreaterThan(512);
    const result = compileOrExplain(value);
    const inventory = getThreadRootedRetainedWitnessInventory(result);
    if (!inventory) throw new Error("expected maximum retained inventory");
    expect(inventory.registry.optionals).toHaveLength(255);
    expect(inventory.manifest.fairOrderedOptionalEntryIds).toHaveLength(255);
    expect(inventory.manifest.laneUndeterminedEntryIds).toEqual([]);
    expect(new Set(inventory.registry.optionals.map((item) =>
      item.entry.entryId
    )).size).toBe(255);

    const entrySpec = {
      hashDomain:
        "muse.attunement-graph.thread-rooted-retained-witness-entry.v1",
      idField: "entryId",
      idPrefix: "muse-thread-rooted-retained-witness-entry:sha256:"
    } as const;
    const manifestSpec = {
      hashDomain:
        "muse.attunement-graph.thread-rooted-retained-witness-manifest.v1",
      idField: "manifestId",
      idPrefix: "muse-thread-rooted-retained-witness-manifest:sha256:"
    } as const;
    const measuredEntries = [
      inventory.registry.core.entry,
      ...inventory.registry.optionals.map((item) => item.entry)
    ].map((entry) =>
      canonicalizeImmutableEnvelope(entry, "muse-frozen", entrySpec)
    );
    const measuredManifest = canonicalizeImmutableEnvelope(
      inventory.manifest,
      "muse-frozen",
      manifestSpec
    );
    for (const measured of [...measuredEntries, measuredManifest]) {
      expect(measured.canonicalByteLength).toBe(
        Buffer.byteLength(measured.canonicalJson, "utf8")
      );
      expect(measured.canonicalByteLength).toBeLessThanOrEqual(
        CANONICAL_IMMUTABLE_ENVELOPE_LIMITS.maxEnvelopeBytes
      );
      const body = copy(measured.envelope) as Record<string, unknown>;
      delete body[measured === measuredManifest ? "manifestId" : "entryId"];
      expect(Buffer.byteLength(canonical(body), "utf8")).toBeLessThanOrEqual(
        CANONICAL_IMMUTABLE_ENVELOPE_LIMITS.maxCanonicalBodyBytes
      );
    }
    expect(Math.max(...measuredEntries.map((item) =>
      item.canonicalByteLength
    ))).toBeLessThan(measuredManifest.canonicalByteLength);
  }, 120_000);

  it("chooses the lexicographically first shortest path and is permutation-stable", () => {
    const value = request();
    const linkA = assertion("\"", A, "LINKED_TO", THREAD);
    const linkB = assertion("#", B, "LINKED_TO", THREAD);
    const routeA = assertion("route-a", C, "REVISION_OF", A);
    const routeB = assertion("route-b", C, "REVISION_OF", B);
    const target = assertion("target", C, "REVISION_OF", D);
    value.boundedResult.assertions = [
      scoped(routeB),
      scoped(target),
      scoped(linkB),
      scoped(routeA),
      scoped(linkA)
    ];
    value.boundedResult.refs = [D, B, C, THREAD, A];
    value.boundedResult.diagnostics.consideredAssertions = 5;
    value.boundedResult.diagnostics.maxDepthReached = 3;
    value.boundedResult.diagnostics.visitedRefs = 5;
    value.nominations.optionals = [{
      assertionId: target.id,
      kind: "change",
      nominationId: "changed-flight",
      observedAt: NOW
    }];
    value.nominations.core.assertionId = linkA.id;
    const first = compileThreadRootedWitnessDocuments(value);
    const permuted = copy(value);
    permuted.boundedResult.assertions.reverse();
    permuted.boundedResult.refs.reverse();
    const second = compileThreadRootedWitnessDocuments(permuted);
    expect(second.receipt.requestId).toBe(first.receipt.requestId);
    expect(second.receipt.receiptId).toBe(first.receipt.receiptId);
    if (first.settlement?.status !== "partial") throw new Error("expected partial");
    const change = first.settlement.documents.find((item) => item.kind === "change");
    expect(change?.proof.paths).toEqual([[
      { assertionId: "\"", direction: "incoming" },
      { assertionId: "route-a", direction: "incoming" },
      { assertionId: "target", direction: "outgoing" }
    ]]);
    for (let index = 0; index < 10; index += 1) {
      expect(compileThreadRootedWitnessDocuments(copy(value)).receipt.receiptId)
        .toBe(first.receipt.receiptId);
    }
  });

  it("binds a normalized semantic request ID and verifies a caller-supplied ID", () => {
    const baseline = request();
    const first = compileThreadRootedWitnessDocuments(baseline);
    const equivalent = request();
    equivalent.query.predicates.reverse();
    equivalent.query.includeSuperseded = false;
    equivalent.requestId = first.receipt.requestId;
    const second = compileThreadRootedWitnessDocuments(equivalent);
    expect(second.receipt.requestId).toBe(first.receipt.requestId);
    expect(second.receipt.receiptId).toBe(first.receipt.receiptId);

    const wrong = request();
    wrong.requestId = `muse-thread-rooted-witness-request:sha256:${"0".repeat(64)}`;
    expect(() => compileThreadRootedWitnessDocuments(wrong))
      .toThrowError(ThreadRootedWitnessDocumentsError);
  });

  it("accounts for unreachable optionals outside settlement and abstains for core", () => {
    const optionalMissing = request();
    optionalMissing.nominations.optionals[0]!.assertionId = "absent";
    const partial = compileThreadRootedWitnessDocuments(optionalMissing);
    expect(partial.status).toBe("partial");
    expect(partial.receipt.coverage.reasons).toContain("nomination-excluded");
    expect(partial.receipt.dispositions[1]).toEqual({
      assertionId: "absent",
      nominationId: "changed-flight",
      reason: "not-in-bounded-result",
      role: "optional",
      status: "excluded"
    });
    if (partial.settlement?.status !== "partial") throw new Error("expected partial");
    expect(partial.settlement.documents).toHaveLength(1);
    const partialInventory =
      getThreadRootedRetainedWitnessInventory(partial);
    expect(partialInventory?.registry.optionals).toEqual([]);
    expect(partialInventory?.manifest.counts).toMatchObject({
      excludedThreadNominations: 1,
      frontierDispositions: 0,
      witnessedOptionals: 0
    });

    const coreMissing = request();
    coreMissing.nominations.core.assertionId = "absent";
    const abstained = compileThreadRootedWitnessDocuments(coreMissing);
    expect(abstained.status).toBe("abstained");
    expect(abstained.settlement).toBeUndefined();
    expect(abstained.receipt.coverage.reasons).toContain("core-witness-unavailable");
    expect(abstained.receipt.settlementResultId).toBeUndefined();
    expect(getThreadRootedRetainedWitnessInventory(abstained)).toBeUndefined();
  });

  it("keeps plan, scope, direction, time, supersession, and truncation honest", () => {
    const cases = [
      {
        name: "scope",
        mutate(value: ReturnType<typeof request>) {
          value.boundedResult.assertions[1]!.memberships = [{
            sourceId: "foreign",
            threadId: "thread-2"
          }];
        },
        reason: "not-scope-eligible"
      },
      {
        name: "predicate",
        mutate(value: ReturnType<typeof request>) {
          value.query.predicates = ["LINKED_TO"];
        },
        reason: "not-plan-eligible"
      },
      {
        name: "recorded time",
        mutate(value: ReturnType<typeof request>) {
          value.boundedResult.assertions[1]!.assertion = assertion(
            "edge-b",
            A,
            "REVISION_OF",
            B,
            { recordedAt: "2026-07-30T09:00:00.000Z" }
          );
        },
        reason: "not-plan-eligible"
      },
      {
        name: "supersession",
        mutate(value: ReturnType<typeof request>) {
          value.boundedResult.assertions[1]!.assertion = assertion(
            "edge-b",
            A,
            "REVISION_OF",
            B,
            { supersededAt: "2026-07-29T09:30:00.000Z" }
          );
        },
        reason: "not-plan-eligible"
      },
      {
        name: "valid time",
        mutate(value: ReturnType<typeof request>) {
          value.boundedResult.assertions[1]!.assertion = assertion(
            "edge-b",
            A,
            "REVISION_OF",
            B,
            { validFrom: "2026-07-29T11:00:00.000Z" }
          );
        },
        reason: "not-plan-eligible"
      },
      {
        name: "direction",
        mutate(value: ReturnType<typeof request>) {
          value.query.direction = "outgoing";
        },
        reason: "not-thread-rooted"
      }
    ];
    for (const fixture of cases) {
      const value = request();
      fixture.mutate(value);
      const result = compileThreadRootedWitnessDocuments(value);
      expect(result.receipt.dispositions[1], fixture.name).toMatchObject({
        reason: fixture.reason,
        status: "excluded"
      });
    }
    const truncated = request();
    truncated.boundedResult.truncated = true;
    expect(
      compileThreadRootedWitnessDocuments(truncated).receipt.coverage.reasons
    ).toContain("traversal-truncated");

    const cyclic = request();
    cyclic.boundedResult.assertions.push(scoped(
      assertion("cycle", B, "REVISION_OF", A)
    ));
    cyclic.boundedResult.diagnostics.consideredAssertions = 3;
    expect(compileThreadRootedWitnessDocuments(cyclic).status).toBe("partial");
  });

  it("rejects cross-thread seeds, inconsistent result budgets, duplicates, and hostile input", () => {
    const wrongSeed = request();
    wrongSeed.query.seeds[0]!.id = "thread-2";
    expect(() => compileThreadRootedWitnessDocuments(wrongSeed))
      .toThrowError(ThreadRootedWitnessDocumentsError);

    const wrongCount = request();
    wrongCount.boundedResult.diagnostics.visitedRefs = 2;
    expect(() => compileThreadRootedWitnessDocuments(wrongCount))
      .toThrowError(ThreadRootedWitnessDocumentsError);

    const duplicate = request();
    duplicate.nominations.optionals[0]!.assertionId = EDGE_A.id;
    expect(() => compileThreadRootedWitnessDocuments(duplicate))
      .toThrowError(ThreadRootedWitnessDocumentsError);

    const reversedFreshness = request();
    reversedFreshness.nominations.core.assertionId = "absent";
    reversedFreshness.declaredFreshness.observedAt = "2026-07-29T11:00:00.000Z";
    expect(() => compileThreadRootedWitnessDocuments(reversedFreshness))
      .toThrowError(ThreadRootedWitnessDocumentsError);

    const invalidScope = request();
    invalidScope.nominations.core.assertionId = "absent";
    invalidScope.scope.sourceId = "not a source";
    expect(() => compileThreadRootedWitnessDocuments(invalidScope))
      .toThrowError(ThreadRootedWitnessDocumentsError);

    const invalidSnapshot = request();
    invalidSnapshot.nominations.core.assertionId = "absent";
    invalidSnapshot.snapshot.commitHash = "sha256:invalid";
    expect(() => compileThreadRootedWitnessDocuments(invalidSnapshot))
      .toThrowError(ThreadRootedWitnessDocumentsError);

    const sparse = request();
    delete sparse.nominations.optionals[0];
    expect(() => compileThreadRootedWitnessDocuments(sparse))
      .toThrowError(ThreadRootedWitnessDocumentsError);

    const customPrototype = request();
    Object.setPrototypeOf(customPrototype, { poisoned: true });
    expect(() => compileThreadRootedWitnessDocuments(customPrototype))
      .toThrowError(ThreadRootedWitnessDocumentsError);

    const aliased = request();
    aliased.boundedResult.assertions[0]!.memberships[0] = aliased.scope;
    expect(() => compileThreadRootedWitnessDocuments(aliased))
      .toThrowError(ThreadRootedWitnessDocumentsError);

    const unsafe = request();
    unsafe.boundedResult.diagnostics.consideredAssertions =
      Number.MAX_SAFE_INTEGER + 1;
    expect(() => compileThreadRootedWitnessDocuments(unsafe))
      .toThrowError(ThreadRootedWitnessDocumentsError);

    let getterRuns = 0;
    const hostile = request();
    Object.defineProperty(hostile, "scope", {
      enumerable: true,
      get() {
        getterRuns += 1;
        return SCOPE;
      }
    });
    expect(() => compileThreadRootedWitnessDocuments(hostile))
      .toThrowError(ThreadRootedWitnessDocumentsError);
    expect(getterRuns).toBe(0);
  });

  it("accepts exact traversal boundaries and rejects each exceeded bound", () => {
    const exact = request();
    exact.query.maxAssertions = 2;
    exact.query.maxConsideredAssertions = 2;
    exact.query.maxDepth = 2;
    exact.query.maxVisitedRefs = 3;
    expect(compileThreadRootedWitnessDocuments(exact).status).toBe("partial");

    const cases = [
      (value: ReturnType<typeof request>) => {
        value.query.maxAssertions = 1;
      },
      (value: ReturnType<typeof request>) => {
        value.query.maxConsideredAssertions = 2;
        value.boundedResult.diagnostics.consideredAssertions = 3;
      },
      (value: ReturnType<typeof request>) => {
        value.query.maxVisitedRefs = 2;
      },
      (value: ReturnType<typeof request>) => {
        value.query.maxDepth = 1;
      }
    ];
    for (const mutate of cases) {
      const value = request();
      mutate(value);
      expect(() => compileThreadRootedWitnessDocuments(value))
        .toThrowError(ThreadRootedWitnessDocumentsError);
    }

    const zeroOutput = request();
    zeroOutput.budget.maxOutputBytes = 0;
    const abstained = compileThreadRootedWitnessDocuments(zeroOutput);
    expect(abstained.status).toBe("abstained");
    expect(abstained.receipt.coverage.canAssertAbsenceWithinSnapshot).toBe(false);
  });
});
