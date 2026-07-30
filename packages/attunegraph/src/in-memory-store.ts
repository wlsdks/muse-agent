import { AttuneGraphDataError } from "./error.js";
import { GRAPH_ASSERTION_SOURCE_NAMESPACE } from "./constants.js";
import {
  canonicalAssertion,
  evidenceRefBaseKey,
  evidenceRefKey,
  graphRefKey,
  instantEpoch,
  normalizeForgetScope,
  normalizeGraphAssertion,
  normalizeGraphAssertionBatch,
  normalizeGraphQueryPlan,
  normalizeRecordedRange
} from "./validation.js";
import type {
  AttuneGraphDataStore,
  GraphAppendReceipt,
  GraphAssertion,
  GraphForgetReceipt,
  GraphForgetScope,
  GraphQueryPlan,
  GraphRecordedRange,
  GraphRef,
  GraphTraversalResult,
  GraphVerification
} from "./types.js";

interface QueueEntry {
  readonly depth: number;
  readonly ref: GraphRef;
}

function compareAssertions(left: GraphAssertion, right: GraphAssertion): number {
  return instantEpoch(left.recordedAt) - instantEpoch(right.recordedAt)
    || left.id.localeCompare(right.id);
}

function assertionMatchesTime(assertion: GraphAssertion, plan: GraphQueryPlan): boolean {
  const recordedCutoff = plan.recordedAtOrBefore
    ? instantEpoch(plan.recordedAtOrBefore)
    : undefined;
  if (recordedCutoff !== undefined && instantEpoch(assertion.recordedAt) > recordedCutoff) {
    return false;
  }
  if (
    !plan.includeSuperseded
    && assertion.supersededAt
    && (
      recordedCutoff === undefined
      || instantEpoch(assertion.supersededAt) <= recordedCutoff
    )
  ) {
    return false;
  }
  if (!plan.validAt) return true;
  const validAt = instantEpoch(plan.validAt);
  return (!assertion.validFrom || instantEpoch(assertion.validFrom) <= validAt)
    && (!assertion.validTo || validAt < instantEpoch(assertion.validTo));
}

function addToIndex(index: Map<string, Set<string>>, key: string, assertionId: string): void {
  const ids = index.get(key);
  if (ids) {
    ids.add(assertionId);
  } else {
    index.set(key, new Set([assertionId]));
  }
}

function removeFromIndex(
  index: Map<string, Set<string>>,
  key: string,
  assertionId: string
): void {
  const ids = index.get(key);
  if (!ids) return;
  ids.delete(assertionId);
  if (ids.size === 0) index.delete(key);
}

function sameIndex(
  left: ReadonlyMap<string, ReadonlySet<string>>,
  right: ReadonlyMap<string, ReadonlySet<string>>
): boolean {
  if (left.size !== right.size) return false;
  for (const [key, leftValues] of left) {
    const rightValues = right.get(key);
    if (!rightValues || leftValues.size !== rightValues.size) return false;
    for (const value of leftValues) {
      if (!rightValues.has(value)) return false;
    }
  }
  return true;
}

/**
 * Deterministic reference adapter. It is intentionally process-local and makes no
 * durability claim; future adapters must pass the same public conformance contract.
 */
export class InMemoryAttuneGraphDataStore implements AttuneGraphDataStore {
  private readonly assertions = new Map<string, GraphAssertion>();
  private readonly assertionFingerprints = new Map<string, string>();
  private readonly incoming = new Map<string, Set<string>>();
  private readonly journalIds: string[] = [];
  private readonly outgoing = new Map<string, Set<string>>();
  private readonly recordedIds: string[] = [];
  private readonly sourceBaseIndex = new Map<string, Set<string>>();
  private readonly sourceIndex = new Map<string, Set<string>>();

  async append(inputs: readonly GraphAssertion[]): Promise<GraphAppendReceipt> {
    const normalizedInputs = normalizeGraphAssertionBatch(inputs);
    const staged = new Map<string, { assertion: GraphAssertion; fingerprint: string }>();
    let replayed = 0;

    // Validate and collision-check the whole batch before mutating any index.
    for (const assertion of normalizedInputs) {
      const fingerprint = canonicalAssertion(assertion);
      const stagedExisting = staged.get(assertion.id);
      if (stagedExisting) {
        if (stagedExisting.fingerprint !== fingerprint) {
          throw new AttuneGraphDataError(
            "ASSERTION_COLLISION",
            `assertion id ${assertion.id} has conflicting content in one append batch`
          );
        }
        replayed += 1;
        continue;
      }
      const existingFingerprint = this.assertionFingerprints.get(assertion.id);
      if (existingFingerprint !== undefined) {
        if (existingFingerprint !== fingerprint) {
          throw new AttuneGraphDataError(
            "ASSERTION_COLLISION",
            `assertion id ${assertion.id} already exists with different content`
          );
        }
        replayed += 1;
        continue;
      }
      staged.set(assertion.id, { assertion, fingerprint });
    }

    for (const { assertion, fingerprint } of staged.values()) {
      this.assertions.set(assertion.id, assertion);
      this.assertionFingerprints.set(assertion.id, fingerprint);
      this.journalIds.push(assertion.id);
      this.insertRecordedId(assertion);
      addToIndex(this.outgoing, graphRefKey(assertion.subject), assertion.id);
      addToIndex(this.incoming, graphRefKey(assertion.object), assertion.id);
      for (const sourceRef of assertion.sourceRefs) {
        addToIndex(this.sourceIndex, evidenceRefKey(sourceRef), assertion.id);
        addToIndex(this.sourceBaseIndex, evidenceRefBaseKey(sourceRef), assertion.id);
      }
    }

    const assertionIds = Object.freeze([...staged.keys()]);
    return Object.freeze({
      appended: assertionIds.length,
      assertionIds,
      replayed
    });
  }

  async forget(input: GraphForgetScope): Promise<GraphForgetReceipt> {
    const scope = normalizeForgetScope(input);
    const removalIds = new Set(scope.assertionIds ?? []);
    for (const ref of scope.graphRefs ?? []) {
      const key = graphRefKey(ref);
      for (const id of this.outgoing.get(key) ?? []) removalIds.add(id);
      for (const id of this.incoming.get(key) ?? []) removalIds.add(id);
    }
    for (const sourceRef of scope.sourceRefs ?? []) {
      const matchingIds = sourceRef.version
        ? this.sourceIndex.get(evidenceRefKey(sourceRef))
        : this.sourceBaseIndex.get(evidenceRefBaseKey(sourceRef));
      for (const id of matchingIds ?? []) {
        removalIds.add(id);
      }
    }

    // Derived assertions may cite another graph assertion as an immutable source.
    // Resolve that dependency closure before mutating indexes so forgetting cannot
    // leave a plausible-looking orphan derivation behind.
    const queue = [...removalIds];
    for (let index = 0; index < queue.length; index += 1) {
      const removedId = queue[index];
      if (!removedId) continue;
      const dependencyKey = evidenceRefBaseKey({
        id: removedId,
        namespace: GRAPH_ASSERTION_SOURCE_NAMESPACE
      });
      for (const dependentId of this.sourceBaseIndex.get(dependencyKey) ?? []) {
        if (removalIds.has(dependentId)) continue;
        removalIds.add(dependentId);
        queue.push(dependentId);
      }
    }

    const removedAssertionIds = [...removalIds]
      .filter((id) => this.assertions.has(id))
      .sort();
    for (const id of removedAssertionIds) this.removeAssertion(id);
    return Object.freeze({
      removed: removedAssertionIds.length,
      removedAssertionIds: Object.freeze(removedAssertionIds)
    });
  }

  async getAssertion(id: string): Promise<GraphAssertion | undefined> {
    return this.assertions.get(id);
  }

  async journal(): Promise<readonly GraphAssertion[]> {
    return Object.freeze(
      this.journalIds.flatMap((id) => {
        const assertion = this.assertions.get(id);
        return assertion ? [assertion] : [];
      })
    );
  }

  async recorded(input: GraphRecordedRange): Promise<readonly GraphAssertion[]> {
    const range = normalizeRecordedRange(input);
    const result: GraphAssertion[] = [];
    const startIndex = range.after
      ? this.firstRecordedAfter(instantEpoch(range.after))
      : 0;
    for (let index = startIndex; index < this.recordedIds.length; index += 1) {
      const id = this.recordedIds[index];
      if (!id) continue;
      const assertion = this.assertions.get(id);
      if (!assertion) continue;
      if (
        range.through
        && instantEpoch(assertion.recordedAt) > instantEpoch(range.through)
      ) {
        break;
      }
      result.push(assertion);
      if (result.length >= range.limit) break;
    }
    return Object.freeze(result);
  }

  async traverse(input: GraphQueryPlan): Promise<GraphTraversalResult> {
    const plan = normalizeGraphQueryPlan(input);
    const predicateSet = new Set(plan.predicates);
    const epistemicSet = plan.epistemicClasses
      ? new Set(plan.epistemicClasses)
      : undefined;
    const queue: QueueEntry[] = plan.seeds.map((ref) => ({ depth: 0, ref }));
    const visitedRefs = new Map(plan.seeds.map((ref) => [graphRefKey(ref), ref]));
    const selectedIds = new Set<string>();
    const consideredIds = new Set<string>();
    let truncated = false;
    let maxDepthReached = 0;

    traversal:
    for (let queueIndex = 0; queueIndex < queue.length; queueIndex += 1) {
      const entry = queue[queueIndex];
      if (!entry || entry.depth >= plan.maxDepth) continue;
      const currentKey = graphRefKey(entry.ref);
      const candidateSources: readonly (ReadonlySet<string> | undefined)[] = [
        ...(plan.direction !== "incoming" ? [this.outgoing.get(currentKey)] : []),
        ...(plan.direction !== "outgoing" ? [this.incoming.get(currentKey)] : [])
      ];
      for (const candidateSource of candidateSources) {
        for (const assertionId of candidateSource ?? []) {
          if (consideredIds.has(assertionId)) continue;
          if (consideredIds.size >= plan.maxConsideredAssertions) {
            truncated = true;
            break traversal;
          }
          consideredIds.add(assertionId);
          const assertion = this.assertions.get(assertionId);
          if (!assertion) continue;
          if (
            !predicateSet.has(assertion.predicate)
            || (epistemicSet && !epistemicSet.has(assertion.epistemicClass))
            || !assertionMatchesTime(assertion, plan)
          ) {
            continue;
          }
          if (selectedIds.size >= plan.maxAssertions) {
            truncated = true;
            break traversal;
          }
          selectedIds.add(assertion.id);

          const neighbors: GraphRef[] = [];
          if (
            plan.direction !== "incoming"
            && graphRefKey(assertion.subject) === currentKey
          ) {
            neighbors.push(assertion.object);
          }
          if (
            plan.direction !== "outgoing"
            && graphRefKey(assertion.object) === currentKey
          ) {
            neighbors.push(assertion.subject);
          }
          for (const neighbor of neighbors.sort((left, right) =>
            graphRefKey(left).localeCompare(graphRefKey(right))
          )) {
            const neighborKey = graphRefKey(neighbor);
            if (visitedRefs.has(neighborKey)) continue;
            if (visitedRefs.size >= plan.maxVisitedRefs) {
              truncated = true;
              continue;
            }
            const nextDepth = entry.depth + 1;
            visitedRefs.set(neighborKey, neighbor);
            queue.push({ depth: nextDepth, ref: neighbor });
            maxDepthReached = Math.max(maxDepthReached, nextDepth);
          }
        }
      }
    }

    const assertions = Object.freeze(
      [...selectedIds]
        .map((id) => this.assertions.get(id))
        .filter((assertion): assertion is GraphAssertion => assertion !== undefined)
    );
    const refs = Object.freeze(
      [...visitedRefs.values()].sort((left, right) =>
        graphRefKey(left).localeCompare(graphRefKey(right))
      )
    );
    return Object.freeze({
      assertions,
      diagnostics: Object.freeze({
        consideredAssertions: consideredIds.size,
        maxDepthReached,
        visitedRefs: refs.length
      }),
      refs,
      truncated
    });
  }

  async verify(): Promise<GraphVerification> {
    const issues: string[] = [];
    if (this.assertions.size !== this.assertionFingerprints.size) {
      issues.push("assertion fingerprint index size mismatch");
    }
    if (this.assertions.size !== this.journalIds.length) {
      issues.push("journal size mismatch");
    }
    if (new Set(this.journalIds).size !== this.journalIds.length) {
      issues.push("journal contains duplicate ids");
    }
    if (this.assertions.size !== this.recordedIds.length) {
      issues.push("recorded-time index size mismatch");
    }
    const expectedOutgoing = new Map<string, Set<string>>();
    const expectedIncoming = new Map<string, Set<string>>();
    const expectedSources = new Map<string, Set<string>>();
    const expectedSourceBases = new Map<string, Set<string>>();
    for (const assertion of this.assertions.values()) {
      try {
        const normalized = normalizeGraphAssertion(assertion);
        if (canonicalAssertion(normalized) !== this.assertionFingerprints.get(assertion.id)) {
          issues.push(`assertion ${assertion.id} fingerprint mismatch`);
        }
      } catch {
        issues.push(`assertion ${assertion.id} is invalid`);
      }
      addToIndex(expectedOutgoing, graphRefKey(assertion.subject), assertion.id);
      addToIndex(expectedIncoming, graphRefKey(assertion.object), assertion.id);
      for (const sourceRef of assertion.sourceRefs) {
        addToIndex(expectedSources, evidenceRefKey(sourceRef), assertion.id);
        addToIndex(expectedSourceBases, evidenceRefBaseKey(sourceRef), assertion.id);
      }
    }
    if (!sameIndex(this.outgoing, expectedOutgoing)) issues.push("outgoing index mismatch");
    if (!sameIndex(this.incoming, expectedIncoming)) issues.push("incoming index mismatch");
    if (!sameIndex(this.sourceIndex, expectedSources)) issues.push("source index mismatch");
    if (!sameIndex(this.sourceBaseIndex, expectedSourceBases)) {
      issues.push("source base index mismatch");
    }
    const expectedRecorded = [...this.assertions.values()].sort(compareAssertions).map(
      (assertion) => assertion.id
    );
    if (expectedRecorded.some((id, index) => this.recordedIds[index] !== id)) {
      issues.push("recorded-time index order mismatch");
    }
    return Object.freeze({
      assertionCount: this.assertions.size,
      issues: Object.freeze(issues),
      ok: issues.length === 0,
      sourceReferenceCount: this.sourceIndex.size
    });
  }

  private insertRecordedId(assertion: GraphAssertion): void {
    let low = 0;
    let high = this.recordedIds.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const middleId = this.recordedIds[middle];
      const middleAssertion = middleId ? this.assertions.get(middleId) : undefined;
      if (!middleAssertion || compareAssertions(middleAssertion, assertion) <= 0) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    this.recordedIds.splice(low, 0, assertion.id);
  }

  private firstRecordedAfter(epoch: number): number {
    let low = 0;
    let high = this.recordedIds.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const id = this.recordedIds[middle];
      const assertion = id ? this.assertions.get(id) : undefined;
      if (!assertion || instantEpoch(assertion.recordedAt) <= epoch) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  }

  private removeAssertion(id: string): void {
    const assertion = this.assertions.get(id);
    if (!assertion) return;
    this.assertions.delete(id);
    this.assertionFingerprints.delete(id);
    const journalIndex = this.journalIds.indexOf(id);
    if (journalIndex >= 0) this.journalIds.splice(journalIndex, 1);
    const recordedIndex = this.recordedIds.indexOf(id);
    if (recordedIndex >= 0) this.recordedIds.splice(recordedIndex, 1);
    removeFromIndex(this.outgoing, graphRefKey(assertion.subject), id);
    removeFromIndex(this.incoming, graphRefKey(assertion.object), id);
    for (const sourceRef of assertion.sourceRefs) {
      removeFromIndex(this.sourceIndex, evidenceRefKey(sourceRef), id);
      removeFromIndex(this.sourceBaseIndex, evidenceRefBaseKey(sourceRef), id);
    }
  }
}
