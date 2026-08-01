import {
  openAttuneGraph,
  type AttuneGraphDecisionQueryResult,
  type AttuneGraphProjectCommand,
  type AttuneGraphScope,
  type GraphAssertion,
  type GraphRef
} from "@attunegraph/core";
import {
  createAttuneGraphStore,
  type AttuneGraphStoredProjection
} from "@attunegraph/core/backend";
import {
  canonicalizeImmutableEnvelope
} from "@attunegraph/core/extension-kit";

const RECEIPT_SPEC = Object.freeze({
  hashDomain: "muse.attunegraph.receipt-bound-decision-evidence.v1",
  idField: "receiptId",
  idPrefix: "muse-attunegraph-receipt-bound-decision-evidence:sha256:"
} as const);

export type ReceiptBoundDecisionEvidenceReceiptV1 = Readonly<{
  readonly schemaVersion: 1;
  readonly receiptVersion: "muse.receipt-bound-decision-evidence-receipt.v1";
  readonly receiptId: string;
  readonly status: "bound" | "abstained";
  readonly use: "evidence-only";
  readonly graphEvidenceReceiptId: string;
  readonly sourceObservationReceiptId: string;
  readonly decisionQueryReceiptId: string;
  readonly decisionQueryStatus: "complete" | "partial" | "abstained";
  readonly scope: AttuneGraphScope;
  readonly actualSeed: GraphRef;
  readonly coreAssertionId: string;
  readonly coverage: Readonly<{
    readonly coreAssertionWitnessed: boolean;
    readonly canAssertAbsenceWithinSnapshot: false;
    readonly canAssertCurrentWorldAbsence: false;
    readonly canGrantActionAuthority: false;
    readonly authorityEvaluation: "not-performed";
    readonly conflictClosure: "not-performed";
  }>;
}>;

export type ReceiptBoundDecisionEvidenceV1 = Readonly<{
  readonly decisionQuery: AttuneGraphDecisionQueryResult;
  readonly receipt: ReceiptBoundDecisionEvidenceReceiptV1;
}>;

export function decisionEvidenceCoversAssertionIds(
  evidence: ReceiptBoundDecisionEvidenceV1,
  assertionIds: readonly string[]
): boolean {
  if (evidence.receipt.status !== "bound") return false;
  const witnessed = new Set(
    evidence.decisionQuery.receipt.witness.assertionIds
  );
  return assertionIds.every((id) => witnessed.has(id));
}

type CompileReceiptBoundDecisionEvidenceInput = Readonly<{
  readonly scope: AttuneGraphScope;
  readonly actualSeed: GraphRef;
  readonly observedAt: string;
  readonly sourceObservationReceiptId: string;
  readonly graphEvidenceReceiptId: string;
  readonly coreAssertionId: string;
  readonly maxEstimatedTokens: number;
  readonly assertions: readonly GraphAssertion[];
}>;

function mutableJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

function sameSnapshot(
  left: AttuneGraphStoredProjection["snapshot"] | undefined,
  right: AttuneGraphStoredProjection["snapshot"] | undefined
): boolean {
  return left !== undefined
    && right !== undefined
    && left.generation === right.generation
    && left.commitId === right.commitId
    && left.scope.sourceId === right.scope.sourceId
    && left.scope.threadId === right.scope.threadId;
}

function sealReceipt(
  body: Omit<ReceiptBoundDecisionEvidenceReceiptV1, "receiptId">
): ReceiptBoundDecisionEvidenceReceiptV1 {
  const first = canonicalizeImmutableEnvelope(
    mutableJson(body),
    "external-mutable",
    RECEIPT_SPEC
  );
  const second = canonicalizeImmutableEnvelope(
    first.envelope,
    "attunegraph-frozen",
    RECEIPT_SPEC
  );
  if (
    first.contentId !== second.contentId
    || first.canonicalJson !== second.canonicalJson
  ) {
    throw new Error("receipt-bound Decision Query evidence is not canonical");
  }
  return second.envelope as ReceiptBoundDecisionEvidenceReceiptV1;
}

/**
 * Compiles one ephemeral exact-head Decision Query over already-admitted fresh
 * source evidence. The Store exists only to exercise AttuneGraph's public
 * projection/query contract; this artifact grants no persistence or authority.
 */
export async function compileReceiptBoundDecisionEvidence(
  input: CompileReceiptBoundDecisionEvidenceInput
): Promise<ReceiptBoundDecisionEvidenceV1> {
  let stored: AttuneGraphStoredProjection | undefined;
  const graph = await openAttuneGraph({
    scope: input.scope,
    store: createAttuneGraphStore({
      async read() {
        return stored;
      },
      async compareAndSwap(_scope, expected, proposed) {
        const matches = stored === undefined
          ? expected === undefined
          : sameSnapshot(stored.snapshot, expected);
        if (!matches) return false;
        stored = mutableJson(proposed) as AttuneGraphStoredProjection;
        return true;
      }
    })
  });
  try {
    const snapshot = await graph.project(mutableJson({
      operator: "canonical-projection@2",
      observation: {
        schemaVersion: 2,
        threadRoot: input.actualSeed,
        observationKey: input.sourceObservationReceiptId,
        scope: input.scope,
        observedAt: input.observedAt,
        sourceFreshness: {
          state: "fresh",
          observedAt: input.observedAt
        },
        assertions: input.assertions
      }
    }) as AttuneGraphProjectCommand);
    const decisionQuery = await graph.query({
      operator: "decision-query@1",
      scope: input.scope,
      seed: input.actualSeed,
      asOf: input.observedAt,
      head: {
        mode: "exact",
        generation: snapshot.generation,
        commitId: snapshot.commitId
      },
      freshness: { require: "fresh" },
      budget: { maxEstimatedTokens: input.maxEstimatedTokens }
    });
    const coreAssertionWitnessed = decisionQuery.receipt.witness.assertionIds
      .includes(input.coreAssertionId);
    const receipt = sealReceipt({
      schemaVersion: 1,
      receiptVersion: "muse.receipt-bound-decision-evidence-receipt.v1",
      status: coreAssertionWitnessed ? "bound" : "abstained",
      use: "evidence-only",
      graphEvidenceReceiptId: input.graphEvidenceReceiptId,
      sourceObservationReceiptId: input.sourceObservationReceiptId,
      decisionQueryReceiptId: decisionQuery.receipt.receiptId,
      decisionQueryStatus: decisionQuery.status,
      scope: input.scope,
      actualSeed: input.actualSeed,
      coreAssertionId: input.coreAssertionId,
      coverage: {
        coreAssertionWitnessed,
        canAssertAbsenceWithinSnapshot: false,
        canAssertCurrentWorldAbsence: false,
        canGrantActionAuthority: false,
        authorityEvaluation: "not-performed",
        conflictClosure: "not-performed"
      }
    });
    return Object.freeze({ decisionQuery, receipt });
  } finally {
    await graph.close();
  }
}
