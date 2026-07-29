import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  ScopedProofDocumentSettlementError,
  compileScopedProofDocumentSettlement
} from "./scoped-proof-document-settlement.js";

const instant = "2026-07-29T00:00:00.000Z";
const scope = { sourceId: "storefront", threadId: "thread-1" };
const snapshot = {
  authority: "caller-declared-read-snapshot",
  commitHash: `sha256:${"a".repeat(64)}`,
  commitSequence: 7,
  generationId: "generation-7"
};
const freshness = { assessedAt: instant, observedAt: instant, status: "fresh" };
const requestDomain = "muse.attunement-graph.scoped-proof-document-settlement-request.v1";
const requestPrefix = "muse-scoped-proof-request:sha256:";
const documentDomain = "muse.attunement-graph.scoped-proof-document.v1";
const documentPrefix = "muse-scoped-proof-document:sha256:";
const budget = {
  maxAssertions: 1_000_000,
  maxConsideredAssertions: 1_000_000,
  maxDepth: 1_000_000,
  maxEstimatedTokens: 1_000_000,
  maxOutputBytes: 1_000_000,
  maxVisitedRefs: 1_000_000
};
function copy<T>(value: T): T { return JSON.parse(JSON.stringify(value)) as T; }

function assertion(id = "assertion-a", sourceRefs = [{ id: "source-a", namespace: "notes" }]) {
  return {
    derivation: { kind: "projection", version: "v1" },
    epistemicClass: "source-observed",
    id,
    object: { id: "thread-1", kind: "thread" },
    predicate: "LINKED_TO",
    recordedAt: instant,
    schemaVersion: 1,
    sourceRefs,
    subject: { id: "artifact-a", kind: "artifact" }
  };
}
function document(kind: "core" | "change" | "support" = "core", index = 0) {
  const item = assertion(`assertion-${index.toString()}`);
  return {
    authority: {
      action: "no-authority-granted",
      freshness: "caller-declared-not-verified",
      nomination: "caller-declared-non-exhaustive"
    },
    declaredFreshness: copy(freshness),
    documentVersion: "muse.scoped-proof-document.v1",
    kind,
    observedAt: instant,
    proof: {
      assertions: [{ assertion: item, memberships: [copy(scope)] }],
      paths: [[{ assertionId: item.id, direction: "outgoing" }]],
      sourceRefs: copy(item.sourceRefs)
    },
    schemaVersion: 1,
    scope: copy(scope),
    semanticPriority: kind === "core" ? 0 : kind === "change" ? 1 : 2,
    snapshot: copy(snapshot)
  };
}
function request(optionals: readonly unknown[] = [], overrides: Record<string, unknown> = {}) {
  return {
    budget: copy(budget),
    core: { document: document(), localStatus: { status: "eligible" } },
    declaredFreshness: copy(freshness),
    operatorVersion: "muse.scoped-proof-document-settlement.v1",
    optionals,
    schemaVersion: 1,
    scope: copy(scope),
    snapshot: copy(snapshot),
    ...overrides
  };
}
function optional(index: number, kind: "change" | "support" = "change") {
  return { document: document(kind, index), localStatus: { status: "eligible" } };
}
function deepFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  if (!Object.isFrozen(value)) return false;
  return Reflect.ownKeys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && "value" in descriptor && descriptor.writable === false
      && descriptor.configurable === false && (key === "length" || deepFrozen(descriptor.value));
  });
}
function errorOf(value: unknown): ScopedProofDocumentSettlementError {
  try { compileScopedProofDocumentSettlement(value); } catch (cause) {
    expect(cause).toBeInstanceOf(ScopedProofDocumentSettlementError);
    return cause as ScopedProofDocumentSettlementError;
  }
  throw new Error("expected failure");
}
function rawCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const root = value as Record<string, unknown>;
  return `{${Object.keys(root).sort(rawCompare).map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(root[key])}`
  ).join(",")}}`;
}
function literalEnvelope(
  value: Record<string, unknown>,
  domain: string,
  idField: string,
  prefix: string
): { readonly canonicalJson: string; readonly contentId: string } {
  const unsigned = copy(value);
  delete unsigned[idField];
  const unsignedJson = canonicalJson(unsigned);
  const digest = createHash("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(unsignedJson, "utf8")
    .digest("hex");
  const contentId = `${prefix}${digest}`;
  return {
    canonicalJson: canonicalJson({ ...unsigned, [idField]: contentId }),
    contentId
  };
}

describe("compileScopedProofDocumentSettlement", () => {
  it("captures, settles, materializes literal retained documents, and freezes the detached result", () => {
    const input = request([optional(1), optional(2, "support")], {
      scope: { ...scope, threadId: "계속-의도" }
    });
    const inputScope = input.scope as typeof scope;
    const coreDocument = input.core.document as ReturnType<typeof document>;
    coreDocument.scope = copy(inputScope);
    coreDocument.proof.assertions[0]!.memberships = [copy(inputScope)];
    for (const item of input.optionals as ReturnType<typeof optional>[]) {
      item.document.scope = copy(inputScope);
      item.document.proof.assertions[0]!.memberships = [copy(inputScope)];
    }
    const expectedDocuments = [
      literalEnvelope(coreDocument, documentDomain, "documentId", documentPrefix),
      ...(input.optionals as ReturnType<typeof optional>[]).map((item) =>
        literalEnvelope(item.document, documentDomain, "documentId", documentPrefix)
      )
    ];
    const original = copy(input);
    const result = compileScopedProofDocumentSettlement(input);
    expect(result.status).toBe("partial");
    if (result.status !== "partial") throw new Error("expected partial");
    expect(result.documents).toHaveLength(3);
    expect(result.completeness.reasons).toEqual(["nomination-not-exhaustive", "freshness-not-authoritative"]);
    expect(Buffer.byteLength(result.contextStream, "utf8")).toBe(result.settlement.totalOutputBytes);
    const byCandidateId = new Map(expectedDocuments.map((item, index) => [
      `${index === 0 ? "core" : "optional"}:${item.contentId.slice(-64)}`,
      item.canonicalJson
    ]));
    const expectedFragments = result.settlement.ledger.entries
      .filter((entry) => entry.terminalState === "admitted")
      .map((entry) => byCandidateId.get(entry.candidateId));
    expect(expectedFragments.every((item) => item !== undefined)).toBe(true);
    expect(result.contextStream).toBe(
      [result.settlement.canonicalJson, ...expectedFragments].join("\n")
    );
    expect(result.settlement.ledger.counters.selectedPayloadBytes).toBe(
      expectedFragments.reduce(
        (total, item) => total + 1 + Buffer.byteLength(item!, "utf8"),
        0
      )
    );
    expect(result.settlement.totalOutputBytes).toBe(
      result.settlement.canonicalByteLength
        + result.settlement.ledger.counters.selectedPayloadBytes
    );
    expect(result.contextStream.startsWith("\uFEFF")).toBe(false);
    expect(result.contextStream.endsWith("\n")).toBe(false);
    expect(result.completeness.canAssertAbsenceWithinSnapshot).toBe(false);
    expect(result.completeness.canAssertCurrentWorldAbsence).toBe(false);
    expect(result.documents.every((item) =>
      item.authority.nomination === "caller-declared-non-exhaustive"
      && item.authority.freshness === "caller-declared-not-verified"
      && item.authority.action === "no-authority-granted"
    )).toBe(true);
    expect(deepFrozen(result)).toBe(true);
    expect(result.documents[0]?.proof.assertions[0]?.assertion).not.toBe(
      coreDocument.proof.assertions[0]?.assertion
    );
    coreDocument.kind = "support";
    expect(result.documents[0]?.kind).toBe(
      (original.core.document as ReturnType<typeof document>).kind
    );
    expect(() => { (result.documents as unknown as { push(value: unknown): void }).push({}); }).toThrow();
  });

  it("keeps raw proof-source ordering distinct from assertion normalizer locale ordering", () => {
    const first = { id: "a", namespace: "z" };
    const second = { id: "a", namespace: "ä" };
    const rawSorted = [first, second].sort((left, right) => {
      const a = JSON.stringify([left.namespace, left.id, null]);
      const b = JSON.stringify([right.namespace, right.id, null]);
      return a < b ? -1 : a > b ? 1 : 0;
    });
    const item = assertion("locale-proof", [second, first]);
    const value = document();
    value.proof.assertions = [{ assertion: item, memberships: [copy(scope)] }];
    value.proof.paths = [[{ assertionId: item.id, direction: "outgoing" }]];
    value.proof.sourceRefs = copy(rawSorted);
    const result = compileScopedProofDocumentSettlement(request([], { core: { document: value, localStatus: { status: "eligible" } } }));
    expect(result.status).toBe("partial");
  });

  it("accepts a lawful exact proof-source union above the former 512-item ceiling", () => {
    const sourceRefs = Array.from({ length: 513 }, (_, index) => ({
      id: `source-${index.toString().padStart(3, "0")}`,
      namespace: "notes"
    }));
    const value = request();
    const doc = value.core.document as ReturnType<typeof document>;
    const sourcesPerAssertion = Math.ceil(sourceRefs.length / 5);
    doc.proof.assertions = Array.from({ length: 5 }, (_, index) => {
      const item = assertion(
        `assertion-${index.toString()}`,
        sourceRefs.slice(index * sourcesPerAssertion, (index + 1) * sourcesPerAssertion)
      );
      return { assertion: item, memberships: [copy(scope)] };
    });
    doc.proof.paths = doc.proof.assertions.map(({ assertion: item }) => [
      { assertionId: item.id, direction: "outgoing" }
    ]);
    doc.proof.sourceRefs = copy(sourceRefs);

    const result = compileScopedProofDocumentSettlement(value);
    expect(result.status).toBe("partial");
    if (result.status !== "partial") throw new Error("expected partial");
    expect(result.documents[0]?.proof.assertions).toHaveLength(5);
    expect(result.documents[0]?.proof.paths).toHaveLength(5);
    expect(result.documents[0]?.proof.sourceRefs).toHaveLength(513);
  });

  it("uses raw UTF-16 order for assertions and paths without locale normalization", () => {
    const value = request();
    const doc = value.core.document as ReturnType<typeof document>;
    const first = assertion("z", [{ id: "z", namespace: "notes" }]);
    const second = assertion("ä", [{ id: "ä", namespace: "notes" }]);
    expect("z".localeCompare("ä")).toBeGreaterThan(0);
    expect(rawCompare("z", "ä")).toBeLessThan(0);
    doc.proof.assertions = [
      { assertion: first, memberships: [copy(scope)] },
      { assertion: second, memberships: [copy(scope)] }
    ];
    doc.proof.paths = [
      [{ assertionId: "z", direction: "outgoing" }],
      [{ assertionId: "ä", direction: "outgoing" }]
    ];
    doc.proof.sourceRefs = [
      { id: "z", namespace: "notes" },
      { id: "ä", namespace: "notes" }
    ];
    expect(compileScopedProofDocumentSettlement(value).status).toBe("partial");

    const descendingAssertions = copy(value);
    const descendingAssertionDocument =
      descendingAssertions.core.document as ReturnType<typeof document>;
    descendingAssertionDocument.proof.assertions.reverse();
    expect(errorOf(descendingAssertions).details).toEqual({
      path: "/core/document/proof/assertions/1",
      reason: "invalid-order"
    });

    const descendingPaths = copy(value);
    const descendingPathDocument =
      descendingPaths.core.document as ReturnType<typeof document>;
    descendingPathDocument.proof.paths.reverse();
    expect(errorOf(descendingPaths).details).toEqual({
      path: "/core/document/proof/paths/1",
      reason: "invalid-order"
    });
  });

  it("enforces all local proof failures, source-order distinction, and supplied-status truth", () => {
    const cases = [
      ["duplicate assertion", (value: ReturnType<typeof request>) => { const doc = value.core.document as ReturnType<typeof document>; doc.proof.paths = [[{ assertionId: "assertion-0", direction: "outgoing" }, { assertionId: "assertion-0", direction: "outgoing" }]]; (value.core as { localStatus: unknown }).localStatus = { reasonId: "proof-duplicate-assertion", status: "rejected" }; }, "abstained"],
      ["missing path reference", (value: ReturnType<typeof request>) => { const doc = value.core.document as ReturnType<typeof document>; doc.proof.paths = [[{ assertionId: "absent", direction: "outgoing" }]]; (value.core as { localStatus: unknown }).localStatus = { reasonId: "proof-path-disconnected", status: "rejected" }; }, "abstained"],
      ["source duplicate", (value: ReturnType<typeof request>) => { const doc = value.core.document as ReturnType<typeof document>; doc.proof.sourceRefs = [copy(doc.proof.sourceRefs[0]!), copy(doc.proof.sourceRefs[0]!)]; (value.core as { localStatus: unknown }).localStatus = { reasonId: "proof-source-unclosed", status: "rejected" }; }, "abstained"]
    ] as const;
    for (const [, change, expected] of cases) { const value = request(); change(value); expect(compileScopedProofDocumentSettlement(value).status).toBe(expected); }
    const descending = request(); const doc = descending.core.document as ReturnType<typeof document>; doc.proof.sourceRefs = [{ id: "z", namespace: "notes" }, { id: "a", namespace: "notes" }];
    const failure = errorOf(descending); expect(failure.details).toEqual({ path: "/core/document/proof/sourceRefs/1", reason: "invalid-order" });
    const mismatch = request(); (mismatch.core as { localStatus: unknown }).localStatus = { reasonId: "proof-source-unclosed", status: "rejected" };
    expect(errorOf(mismatch).details.reason).toBe("invalid-local-status");
  });

  it("pins local-proof failure precedence before supplied-status validation", () => {
    const cases: readonly {
      readonly name: string;
      readonly reason: "proof-duplicate-assertion" | "proof-duplicate-path"
        | "proof-path-disconnected" | "proof-source-unclosed";
      readonly change: (value: ReturnType<typeof request>) => void;
    }[] = [
      {
        name: "duplicate assertion IDs precede every later proof defect",
        reason: "proof-duplicate-assertion",
        change(value) {
          const doc = value.core.document as ReturnType<typeof document>;
          doc.proof.assertions.push(copy(doc.proof.assertions[0]!));
          doc.proof.paths = [[
            { assertionId: "assertion-0", direction: "outgoing" },
            { assertionId: "assertion-0", direction: "outgoing" }
          ]];
          doc.proof.sourceRefs = [];
        }
      },
      {
        name: "duplicate paths precede their missing assertion reference",
        reason: "proof-duplicate-path",
        change(value) {
          const doc = value.core.document as ReturnType<typeof document>;
          const broken = [{ assertionId: "absent", direction: "outgoing" as const }];
          doc.proof.paths = [copy(broken), copy(broken)];
          doc.proof.sourceRefs = [];
        }
      },
      {
        name: "disconnection precedes unused assertions and source mismatch",
        reason: "proof-path-disconnected",
        change(value) {
          const doc = value.core.document as ReturnType<typeof document>;
          const second = assertion("assertion-1", [{ id: "source-b", namespace: "notes" }]);
          second.subject.id = "artifact-b";
          doc.proof.assertions.push({ assertion: second, memberships: [copy(scope)] });
          doc.proof.paths = [[
            { assertionId: "assertion-0", direction: "outgoing" },
            { assertionId: "assertion-1", direction: "outgoing" }
          ]];
          doc.proof.sourceRefs = [];
        }
      },
      {
        name: "unused assertions precede the independently mismatched source union",
        reason: "proof-source-unclosed",
        change(value) {
          const doc = value.core.document as ReturnType<typeof document>;
          const second = assertion("assertion-1", [{ id: "source-b", namespace: "notes" }]);
          doc.proof.assertions.push({ assertion: second, memberships: [copy(scope)] });
          doc.proof.paths = [[{ assertionId: "assertion-0", direction: "outgoing" }]];
          doc.proof.sourceRefs = [{ id: "unrelated", namespace: "notes" }];
        }
      }
    ];
    for (const { change, name, reason } of cases) {
      const value = request();
      change(value);
      (value.core as { localStatus: unknown }).localStatus = {
        reasonId: reason,
        status: "rejected"
      };
      const result = compileScopedProofDocumentSettlement(value);
      expect(result.status, name).toBe("abstained");
      if (result.status !== "abstained") throw new Error(name);
      expect(result.settlement.ledger.entries[0]).toEqual({
        candidateId: expect.stringMatching(/^core:[0-9a-f]{64}$/u),
        reasonId: `semantic:${reason}`,
        role: "core",
        terminalState: "rejected"
      });
      expect(result.settlement.ledger.counters.selectedPayloadBytes).toBe(0);
      expect(result.contextStream).toBe(result.settlement.canonicalJson);
    }
  });

  it("crosses the local-status truth table with every freshness declaration", () => {
    for (const status of ["fresh", "stale", "rebuilding", "unavailable"] as const) {
      const actualFreshness = status === "fresh" || status === "stale"
        ? { ...freshness, status }
        : {
            reasonId: status === "rebuilding" ? "incomplete-rebuild" : "caller-unavailable",
            status
          };
      const base = () => request([], {
        declaredFreshness: copy(actualFreshness),
        core: {
          document: { ...document(), declaredFreshness: copy(actualFreshness) },
          localStatus: { status: "eligible" }
        }
      });

      const eligible = compileScopedProofDocumentSettlement(base());
      expect(eligible.status).toBe(
        status === "fresh" || status === "stale" ? "partial" : "abstained"
      );

      const matching = base();
      const matchingDocument = matching.core.document as ReturnType<typeof document>;
      matchingDocument.proof.paths = [[{ assertionId: "missing", direction: "outgoing" }]];
      (matching.core as { localStatus: unknown }).localStatus = {
        reasonId: "proof-path-disconnected",
        status: "rejected"
      };
      expect(compileScopedProofDocumentSettlement(matching).status).toBe("abstained");

      const falseRejection = base();
      (falseRejection.core as { localStatus: unknown }).localStatus = {
        reasonId: "proof-path-disconnected",
        status: "rejected"
      };
      expect(errorOf(falseRejection).details.reason).toBe("invalid-local-status");

      const falseEligibility = base();
      const falseEligibilityDocument =
        falseEligibility.core.document as ReturnType<typeof document>;
      falseEligibilityDocument.proof.paths = [[
        { assertionId: "missing", direction: "outgoing" }
      ]];
      expect(errorOf(falseEligibility).details.reason).toBe("invalid-local-status");

      const wrongReason = base();
      const wrongReasonDocument = wrongReason.core.document as ReturnType<typeof document>;
      wrongReasonDocument.proof.paths = [[
        { assertionId: "missing", direction: "outgoing" }
      ]];
      (wrongReason.core as { localStatus: unknown }).localStatus = {
        reasonId: "proof-source-unclosed",
        status: "rejected"
      };
      expect(errorOf(wrongReason).details.reason).toBe("invalid-local-status");
    }
  });

  it("rejects scope, snapshot, and freshness drift while retaining inert shared membership", () => {
    const mismatches = [
      {
        change(value: ReturnType<typeof request>) {
          const doc = value.core.document as ReturnType<typeof document>;
          doc.scope.sourceId = "foreign";
        },
        path: "/core/document/scope",
        reason: "scope-mismatch"
      },
      {
        change(value: ReturnType<typeof request>) {
          const doc = value.core.document as ReturnType<typeof document>;
          doc.scope.threadId = "other-thread";
        },
        path: "/core/document/scope",
        reason: "scope-mismatch"
      },
      {
        change(value: ReturnType<typeof request>) {
          const doc = value.core.document as ReturnType<typeof document>;
          doc.snapshot.commitSequence += 1;
        },
        path: "/core/document/snapshot",
        reason: "snapshot-mismatch"
      },
      {
        change(value: ReturnType<typeof request>) {
          const doc = value.core.document as ReturnType<typeof document>;
          doc.declaredFreshness.status = "stale";
        },
        path: "/core/document/declaredFreshness",
        reason: "freshness-mismatch"
      },
      {
        change(value: ReturnType<typeof request>) {
          const doc = value.core.document as ReturnType<typeof document>;
          doc.observedAt = "2026-07-30T00:00:00.000Z";
        },
        path: "/core/document/observedAt",
        reason: "freshness-mismatch"
      }
    ] as const;
    for (const mismatch of mismatches) {
      const value = request();
      mismatch.change(value);
      expect(errorOf(value).details).toEqual({
        path: mismatch.path,
        reason: mismatch.reason
      });
    }

    const foreignOnly = request();
    const foreignOnlyDocument =
      foreignOnly.core.document as ReturnType<typeof document>;
    foreignOnlyDocument.proof.assertions[0]!.memberships = [{
      sourceId: "archive",
      threadId: "other-thread"
    }];
    expect(errorOf(foreignOnly).details).toEqual({
      path: "/core/document/proof/assertions/0/memberships",
      reason: "scope-mismatch"
    });

    const shared = request();
    const sharedDocument = shared.core.document as ReturnType<typeof document>;
    sharedDocument.proof.assertions[0]!.memberships = [
      { sourceId: "archive", threadId: "other-thread" },
      copy(scope)
    ];
    const result = compileScopedProofDocumentSettlement(shared);
    if (result.status !== "partial") throw new Error("expected partial");
    expect(result.documents[0]?.proof.assertions[0]?.memberships).toEqual([
      { sourceId: "archive", threadId: "other-thread" },
      scope
    ]);
    expect(result.documents[0]?.authority).toEqual({
      action: "no-authority-granted",
      freshness: "caller-declared-not-verified",
      nomination: "caller-declared-non-exhaustive"
    });
  });

  it("maps freshness statuses and output modes without a complete or absence claim", () => {
    for (const status of ["fresh", "stale", "rebuilding", "unavailable"] as const) {
      const actualFreshness = status === "fresh" || status === "stale" ? { ...freshness, status } : { reasonId: status === "rebuilding" ? "incomplete-rebuild" : "caller-unavailable", status };
      const value = request([], { declaredFreshness: copy(actualFreshness), core: { document: { ...document(), declaredFreshness: copy(actualFreshness) }, localStatus: { status: "eligible" } } });
      const result = compileScopedProofDocumentSettlement(value);
      expect(result.status).toBe(status === "fresh" || status === "stale" ? "partial" : "abstained");
      if (result.status !== "invalid-input") {
        expect(result.completeness.canAssertAbsenceWithinSnapshot).toBe(false);
        expect(result.completeness.canAssertCurrentWorldAbsence).toBe(false);
      }
    }
    const noCapacity = request([], { budget: { ...budget, maxEstimatedTokens: 0, maxOutputBytes: 0 } });
    const capacity = compileScopedProofDocumentSettlement(noCapacity);
    expect(capacity.status).toBe("invalid-input");
    if (capacity.status !== "invalid-input") throw new Error("expected capacity result");
    expect(capacity).not.toHaveProperty("contextStream");
    expect(capacity.capacity.error.reasonId).toBe("minimum-abstention-exceeds-budget");
    expect(deepFrozen(capacity)).toBe(true);
  });

  it("preserves 045b gate order, rollback counters, and normal/core-only/abstain modes", () => {
    const high = compileScopedProofDocumentSettlement(
      request([optional(1), optional(2, "support")])
    );
    if (high.status !== "partial") throw new Error("expected normal result");
    expect(high.settlement.ledger.mode).toBe("normal");

    const coreOnly = compileScopedProofDocumentSettlement(
      request([optional(1), optional(2, "support")], {
        budget: {
          ...budget,
          maxOutputBytes: high.settlement.ledger.counters.selectedPayloadBytes
        }
      })
    );
    expect(coreOnly.status).toBe("partial");
    if (coreOnly.status !== "partial") throw new Error("expected core-only result");
    expect(coreOnly.settlement.ledger.mode).toBe("core-only");
    expect(coreOnly.documents).toHaveLength(1);
    expect(coreOnly.completeness.reasons).toEqual([
      "nomination-not-exhaustive",
      "freshness-not-authoritative",
      "candidate-not-admitted"
    ]);

    const optionalFailure = compileScopedProofDocumentSettlement(
      request([optional(1), optional(2)], {
        budget: { ...budget, maxAssertions: 1 }
      })
    );
    if (optionalFailure.status !== "partial") throw new Error("expected partial");
    expect(optionalFailure.settlement.ledger.mode).toBe("normal");
    expect(optionalFailure.settlement.ledger.entries.map((entry) =>
      entry.terminalState
    )).toEqual(["admitted", "failed", "skipped"]);
    expect(optionalFailure.settlement.ledger.counters).toMatchObject({
      admitted: 1,
      consideredAssertions: 2,
      failed: 1,
      selectedAssertions: 1,
      skipped: 1,
      visitedRefs: 4
    });
    expect(optionalFailure.documents).toHaveLength(1);

    const one = compileScopedProofDocumentSettlement(request());
    if (one.status !== "partial") throw new Error("expected one admitted core");
    const candidateTokenCost =
      one.settlement.ledger.counters.selectedPayloadEstimatedTokens;
    const candidateByteCost = one.settlement.ledger.counters.selectedPayloadBytes;
    const axes = [
      ["depth", { maxDepth: 0 }, {
        consideredAssertions: 0,
        selectedAssertions: 0,
        visitedRefs: 0
      }],
      ["considered", { maxConsideredAssertions: 0 }, {
        consideredAssertions: 0,
        selectedAssertions: 0,
        visitedRefs: 0
      }],
      ["visited", { maxVisitedRefs: 1 }, {
        consideredAssertions: 1,
        selectedAssertions: 0,
        visitedRefs: 0
      }],
      ["assertions", { maxAssertions: 0 }, {
        consideredAssertions: 1,
        selectedAssertions: 0,
        visitedRefs: 2
      }],
      ["token", { maxEstimatedTokens: candidateTokenCost - 1 }, {
        consideredAssertions: 1,
        selectedAssertions: 0,
        visitedRefs: 2
      }],
      ["bytes", { maxOutputBytes: candidateByteCost - 1 }, {
        consideredAssertions: 1,
        selectedAssertions: 0,
        visitedRefs: 2
      }]
    ] as const;
    for (const [axis, limit, expectedCounters] of axes) {
      const result = compileScopedProofDocumentSettlement(
        request([], { budget: { ...budget, ...limit } })
      );
      expect(result.status, axis).toBe("abstained");
      if (result.status !== "abstained") throw new Error(axis);
      expect(result.settlement.ledger.mode).toBe("abstain");
      expect(result.settlement.ledger.firstViolatedAxis).toBe(axis);
      expect(result.settlement.ledger.entries[0]).toMatchObject({
        reasonId: `budget:${axis}`,
        terminalState: "failed"
      });
      expect(result.settlement.ledger.counters).toMatchObject(expectedCounters);
      expect(result.contextStream).toBe(result.settlement.canonicalJson);
    }
  });

  it("accepts 0 and 255 optionals, rejects 256, and is fully permutation-invariant", () => {
    expect(compileScopedProofDocumentSettlement(request()).status).toBe("partial");
    const many = Array.from({ length: 255 }, (_, index) => optional(index + 1, index % 2 === 0 ? "change" : "support"));
    const forward = compileScopedProofDocumentSettlement(request(many));
    const reverse = compileScopedProofDocumentSettlement(request([...many].reverse()));
    const rotatedItems = [...many.slice(73), ...many.slice(0, 73)];
    const rotated = compileScopedProofDocumentSettlement(request(rotatedItems));
    expect(forward.status).toBe("partial");
    expect(reverse.status).toBe("partial");
    expect(rotated.status).toBe("partial");
    if (
      forward.status === "partial"
      && reverse.status === "partial"
      && rotated.status === "partial"
    ) {
      for (const variant of [reverse, rotated]) {
        expect(variant.resultId).toBe(forward.resultId);
        expect(variant.settlement.canonicalJson).toBe(forward.settlement.canonicalJson);
        expect(variant.settlement.ledger.inventoryId).toBe(
          forward.settlement.ledger.inventoryId
        );
        expect(variant.settlement.ledger.entries).toEqual(
          forward.settlement.ledger.entries
        );
        expect(variant.contextStream).toBe(forward.contextStream);
        expect(variant.documents.map((item) => item.documentId)).toEqual(
          forward.documents.map((item) => item.documentId)
        );
      }
    }
    expect(errorOf(request([...many, optional(256)])).details.reason).toBe("too-many-optionals");

    const repeated = optional(900);
    expect(errorOf(request([copy(repeated), copy(repeated)])).details).toEqual({
      path: "/optionals/1/document/documentId",
      reason: "duplicate-document-id"
    });
  });

  it("ranks eligible optionals by priority, observed time, then raw document ID", () => {
    const newer = optional(20, "change");
    const older = optional(21, "change");
    older.document.observedAt = "2026-07-28T00:00:00.000Z";
    const newerId = literalEnvelope(
      newer.document,
      documentDomain,
      "documentId",
      documentPrefix
    ).contentId;
    const olderId = literalEnvelope(
      older.document,
      documentDomain,
      "documentId",
      documentPrefix
    ).contentId;
    const observedResult = compileScopedProofDocumentSettlement(
      request([older, newer], { budget: { ...budget, maxAssertions: 2 } })
    );
    if (observedResult.status !== "partial") throw new Error("expected partial");
    const observedStates = new Map(observedResult.settlement.ledger.entries.map((entry) => [
      entry.candidateId,
      entry.terminalState
    ]));
    expect(observedStates.get(`optional:${newerId.slice(-64)}`)).toBe("admitted");
    expect(observedStates.get(`optional:${olderId.slice(-64)}`)).toBe("failed");

    const left = optional(30, "change");
    const right = optional(31, "change");
    const leftId = literalEnvelope(
      left.document,
      documentDomain,
      "documentId",
      documentPrefix
    ).contentId;
    const rightId = literalEnvelope(
      right.document,
      documentDomain,
      "documentId",
      documentPrefix
    ).contentId;
    const [firstId, secondId] = [leftId, rightId].sort(rawCompare);
    if (firstId === undefined || secondId === undefined) {
      throw new Error("expected two sorted document IDs");
    }
    const tieResult = compileScopedProofDocumentSettlement(
      request([right, left], { budget: { ...budget, maxAssertions: 2 } })
    );
    if (tieResult.status !== "partial") throw new Error("expected partial");
    const tieStates = new Map(tieResult.settlement.ledger.entries.map((entry) => [
      entry.candidateId,
      entry.terminalState
    ]));
    expect(tieStates.get(`optional:${firstId.slice(-64)}`)).toBe("admitted");
    expect(tieStates.get(`optional:${secondId.slice(-64)}`)).toBe("failed");
  });

  it("pins multibyte context bytes immediately below, at, and above the exact boundary", () => {
    const base = request([optional(1)], {
      scope: { ...scope, threadId: "계속-의도" }
    });
    const baseScope = base.scope as typeof scope;
    const coreDocument = base.core.document as ReturnType<typeof document>;
    coreDocument.scope = copy(baseScope);
    coreDocument.proof.assertions[0]!.memberships = [copy(baseScope)];
    const optionalDocument =
      (base.optionals[0] as ReturnType<typeof optional>).document;
    optionalDocument.scope = copy(baseScope);
    optionalDocument.proof.assertions[0]!.memberships = [copy(baseScope)];

    let exactBudget = budget.maxOutputBytes;
    let exactResult: ReturnType<typeof compileScopedProofDocumentSettlement> | undefined;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const value = copy(base);
      value.budget.maxOutputBytes = exactBudget;
      const result = compileScopedProofDocumentSettlement(value);
      if (result.status !== "partial" || result.settlement.ledger.mode !== "normal") {
        throw new Error("failed to converge exact byte boundary");
      }
      exactResult = result;
      if (result.settlement.totalOutputBytes === exactBudget) break;
      exactBudget = result.settlement.totalOutputBytes;
    }
    if (
      exactResult?.status !== "partial"
      || exactResult.settlement.totalOutputBytes !== exactBudget
    ) {
      throw new Error("exact byte boundary did not stabilize");
    }
    expect(exactResult.contextStream).toContain("계속-의도");
    expect(Buffer.byteLength(exactResult.contextStream, "utf8")).toBe(exactBudget);
    expect(exactResult.settlement.ledger.mode).toBe("normal");
    expect(exactResult.documents).toHaveLength(2);

    const above = copy(base);
    above.budget.maxOutputBytes = exactBudget + 1;
    const aboveResult = compileScopedProofDocumentSettlement(above);
    if (aboveResult.status !== "partial") throw new Error("expected above boundary");
    expect(aboveResult.settlement.ledger.mode).toBe("normal");
    expect(aboveResult.settlement.totalOutputBytes).toBe(exactBudget);
    expect(aboveResult.documents).toHaveLength(2);

    const below = copy(base);
    below.budget.maxOutputBytes = exactBudget - 1;
    const belowResult = compileScopedProofDocumentSettlement(below);
    if (belowResult.status !== "partial") throw new Error("expected below boundary");
    expect(belowResult.settlement.ledger.mode).toBe("core-only");
    expect(belowResult.settlement.totalOutputBytes).toBeLessThanOrEqual(exactBudget - 1);
    expect(belowResult.documents).toHaveLength(1);
  });

  it("sanitizes capture failures and hostile input without executing behavior", () => {
    const accessor = request(); let calls = 0;
    Object.defineProperty(accessor, "scope", { enumerable: true, get() { calls += 1; return scope; } });
    expect(errorOf(accessor).details).toEqual({ path: "/scope", reason: "invalid-request-envelope" }); expect(calls).toBe(0);
    let proxyCalls = 0;
    const proxy = new Proxy(request(), {
      getOwnPropertyDescriptor() {
        proxyCalls += 1;
        throw new Error("must not execute");
      },
      ownKeys() {
        proxyCalls += 1;
        throw new Error("must not execute");
      }
    });
    expect(errorOf(proxy).details).toEqual({
      path: "",
      reason: "invalid-request-envelope"
    });
    expect(proxyCalls).toBe(0);
    const alias = request();
    alias.optionals = [alias.core];
    expect(errorOf(alias).details).toEqual({
      path: "/optionals/0",
      reason: "invalid-request-envelope"
    });
    const cyclic = request();
    const cycle: unknown[] = [];
    cycle.push(cycle);
    cyclic.optionals = cycle;
    expect(errorOf(cyclic).details).toEqual({
      path: "/optionals/0",
      reason: "invalid-request-envelope"
    });
    const sparse = request();
    sparse.optionals = new Array(1);
    expect(errorOf(sparse).details).toEqual({
      path: "/optionals",
      reason: "invalid-request-envelope"
    });
    const symbol = request() as ReturnType<typeof request> & { [key: symbol]: boolean };
    symbol[Symbol("hostile")] = true;
    expect(errorOf(symbol).details).toEqual({
      path: "",
      reason: "invalid-request-envelope"
    });
    const unsafe = request([], {
      budget: { ...budget, maxDepth: Number.MAX_SAFE_INTEGER + 1 }
    });
    expect(errorOf(unsafe).details).toEqual({
      path: "/budget/maxDepth",
      reason: "invalid-request-envelope"
    });
    const frozenRequest = Object.freeze(request());
    expect(errorOf(frozenRequest).details).toEqual({
      path: "",
      reason: "invalid-request-envelope"
    });
    const oversized = request([], {
      scope: { ...scope, threadId: "x".repeat(16_385) }
    });
    expect(errorOf(oversized).details).toEqual({
      path: "/scope/threadId",
      reason: "request-envelope-budget-exceeded"
    });
    const documentId = `muse-scoped-proof-document:sha256:${"0".repeat(64)}`;
    expect(errorOf(request([], { core: { document: { ...document(), documentId }, localStatus: { status: "eligible" } } })).details).toEqual({ path: "/core/document/documentId", reason: "invalid-document-id" });
    const malformedSource = request();
    const malformedDocument = malformedSource.core.document as ReturnType<typeof document>;
    malformedDocument.proof.sourceRefs = [
      { id: "source-a", namespace: "notes", extra: true } as never
    ];
    expect(errorOf(malformedSource).details).toEqual({
      path: "/core/document/proof/sourceRefs/0",
      reason: "invalid-assertion"
    });
    const malformed = request(); (malformed as { schemaVersion: unknown }).schemaVersion = 2;
    expect(errorOf(malformed).details).toEqual({ path: "/schemaVersion", reason: "invalid-schema-version" });
  });

  it("pins supplied and inserted request/document domain-NUL identities", () => {
    const unsignedRequest = request();
    const expectedRequest = literalEnvelope(
      unsignedRequest,
      requestDomain,
      "requestId",
      requestPrefix
    );
    const suppliedRequest = { ...unsignedRequest, requestId: expectedRequest.contentId };
    const expectedDocument = literalEnvelope(
      suppliedRequest.core.document as ReturnType<typeof document>,
      documentDomain,
      "documentId",
      documentPrefix
    );
    const result = compileScopedProofDocumentSettlement(suppliedRequest);
    if (result.status !== "partial") throw new Error("expected partial");
    const literal = result.contextStream.slice(
      result.settlement.canonicalJson.length + 1
    );
    expect(literal).toBe(expectedDocument.canonicalJson);
    expect(result.documents[0]?.documentId).toBe(expectedDocument.contentId);

    const wrongRequestId = {
      ...request(),
      requestId: `${requestPrefix}${"0".repeat(64)}`
    };
    expect(errorOf(wrongRequestId).details).toEqual({
      path: "/requestId",
      reason: "invalid-request-id"
    });
    const malformedRequestId = { ...request(), requestId: "not-an-id" };
    expect(errorOf(malformedRequestId).details).toEqual({
      path: "/requestId",
      reason: "invalid-request-id"
    });
  });

  it("uses raw tuple order for memberships and preserves duplicate ownership", () => {
    const value = request();
    const doc = value.core.document as ReturnType<typeof document>;
    doc.proof.assertions[0]!.memberships = [
      { sourceId: "storefront", threadId: "\"" },
      { sourceId: "storefront", threadId: "0" },
      copy(scope)
    ];
    expect(compileScopedProofDocumentSettlement(value).status).toBe("partial");

    const duplicate = request();
    const duplicateDocument = duplicate.core.document as ReturnType<typeof document>;
    duplicateDocument.proof.assertions[0]!.memberships = [copy(scope), copy(scope)];
    expect(errorOf(duplicate).details).toEqual({
      path: "/core/document/proof/assertions/0/memberships",
      reason: "duplicate-membership"
    });
  });

  it("exposes only the sanitized exact error contract", () => {
    const failure = errorOf({ ...request(), requestId: "bad" });
    expect(failure.code).toBe("INVALID_REQUEST");
    expect(failure.name).toBe("ScopedProofDocumentSettlementError");
    expect(failure.message).toBe("scoped-proof-document-settlement-failed");
    expect(failure.stack).toBeUndefined();
    expect("cause" in failure).toBe(false);
    expect(Reflect.ownKeys(failure).sort()).toEqual(
      ["code", "details", "message", "name"].sort()
    );
    expect(Object.getPrototypeOf(failure.details)).toBeNull();
    expect(deepFrozen(failure.details)).toBe(true);
    for (const key of Reflect.ownKeys(failure)) {
      const descriptor = Object.getOwnPropertyDescriptor(failure, key);
      expect(descriptor).toMatchObject({
        configurable: false,
        writable: false
      });
      expect(descriptor?.enumerable).toBe(key === "code" || key === "details");
    }
  });
});
