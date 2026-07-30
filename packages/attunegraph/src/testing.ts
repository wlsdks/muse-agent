import { GRAPH_ASSERTION_SOURCE_NAMESPACE } from "./constants.js";
import type {
  AttuneGraphDataStore,
  GraphAssertion,
  GraphEvidenceRef,
  GraphRef
} from "./types.js";
export { createInMemoryAttuneGraphStore, InMemoryAttuneGraphStoreBackend } from "./attunegraph-in-memory-store.js";
export type { AttuneGraphStoreBackend, AttuneGraphStoredProjection } from "./attunegraph-backend.js";
export {
  runAttuneGraphStoreConformance,
  type AttuneGraphStoreConformanceBackend,
  type AttuneGraphStoreBackendFactory,
  type AttuneGraphStoreConformanceCase,
  type AttuneGraphStoreConformanceReport
} from "./attunegraph-testing.js";

const THREAD: GraphRef = { id: "conformance_thread", kind: "thread" };
const SOURCE: GraphEvidenceRef = {
  id: "conformance_source",
  namespace: "example.conformance",
  version: "v1"
};

export interface AttuneGraphDataStoreConformanceCase {
  readonly name: string;
  readonly passed: true;
}

export interface AttuneGraphDataStoreConformanceReport {
  readonly cases: readonly AttuneGraphDataStoreConformanceCase[];
  readonly passed: true;
}

export type AttuneGraphDataStoreFactory = () =>
  | AttuneGraphDataStore
  | Promise<AttuneGraphDataStore>;

function fixture(
  id: string,
  overrides: Partial<GraphAssertion> = {}
): GraphAssertion {
  return {
    schemaVersion: 1,
    id,
    subject: { id: `artifact_${id}`, kind: "artifact" },
    predicate: "LINKED_TO",
    object: THREAD,
    epistemicClass: "source-observed",
    sourceRefs: [SOURCE],
    recordedAt: "2026-07-29T01:00:00.000Z",
    derivation: { kind: "projection", version: "conformance-v1" },
    ...overrides
  };
}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function caseResult(
  name: string,
  operation: () => Promise<void>
): Promise<AttuneGraphDataStoreConformanceCase> {
  try {
    await operation();
    return Object.freeze({ name, passed: true as const });
  } catch (cause) {
    throw new Error(`AttuneGraph store conformance failed: ${name}`, { cause });
  }
}

/**
 * Backend-neutral executable contract. It deliberately uses only the public store port.
 */
export async function runAttuneGraphDataStoreConformance(
  createStore: AttuneGraphDataStoreFactory
): Promise<AttuneGraphDataStoreConformanceReport> {
  const definitions: readonly (readonly [string, () => Promise<void>])[] = [
    ["atomic append and idempotent replay", async () => {
      const store = await createStore();
      const first = fixture("first");
      const second = fixture("second");
      const receipt = await store.append([first, second]);
      check(receipt.appended === 2 && receipt.replayed === 0, "initial append receipt");
      const replay = await store.append([first]);
      check(replay.appended === 0 && replay.replayed === 1, "idempotent replay receipt");
      let collisionRejected = false;
      try {
        await store.append([
          { ...first, recordedAt: "2026-07-29T02:00:00.000Z" },
          fixture("must_not_append")
        ]);
      } catch {
        collisionRejected = true;
      }
      check(collisionRejected, "collision must reject");
      check(await store.getAssertion("must_not_append") === undefined, "batch must be atomic");
    }],
    ["deterministic bounded traversal", async () => {
      const store = await createStore();
      await store.append([fixture("one"), fixture("two")]);
      const result = await store.traverse({
        seeds: [THREAD],
        predicates: ["LINKED_TO"],
        direction: "incoming",
        maxDepth: 1,
        maxAssertions: 1,
        maxConsideredAssertions: 2,
        maxVisitedRefs: 2
      });
      check(result.assertions.length === 1, "assertion cap");
      check(result.truncated, "result cap must report truncation");
      check(result.diagnostics.visitedRefs <= 2, "visited-ref cap");
    }],
    ["recorded-time ordering", async () => {
      const store = await createStore();
      await store.append([
        fixture("late", { recordedAt: "2026-07-29T03:00:00.000Z" }),
        fixture("early", { recordedAt: "2026-07-29T01:00:00.000Z" })
      ]);
      const recorded = await store.recorded({ limit: 10 });
      check(
        recorded.map((assertion) => assertion.id).join(",") === "early,late",
        "recorded index must be chronological"
      );
    }],
    ["forget cascade and index verification", async () => {
      const store = await createStore();
      await store.append([
        fixture("source_assertion"),
        fixture("derived_assertion", {
          subject: { id: "artifact_derived", kind: "artifact" },
          predicate: "DERIVED_FROM",
          object: { id: "evidence_source", kind: "evidence" },
          epistemicClass: "deterministic-derived",
          sourceRefs: [{
            id: "source_assertion",
            namespace: GRAPH_ASSERTION_SOURCE_NAMESPACE
          }],
          derivation: { kind: "rule", version: "conformance-rule-v1" }
        })
      ]);
      const receipt = await store.forget({ sourceRefs: [SOURCE] });
      check(receipt.removed === 2, "forget must cascade through assertion provenance");
      const verification = await store.verify();
      check(verification.ok && verification.assertionCount === 0, "indexes after forget");
    }]
  ];
  const cases: AttuneGraphDataStoreConformanceCase[] = [];
  for (const [name, operation] of definitions) {
    cases.push(await caseResult(name, operation));
  }
  return Object.freeze({
    cases: Object.freeze(cases),
    passed: true as const
  });
}
