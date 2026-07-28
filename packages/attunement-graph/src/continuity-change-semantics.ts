import type {
  ContinuityChangePathStep,
  ContinuityChangeTemporalBasis
} from "./continuity-change-query.js";
import type {
  ContinuityGraphProjection,
  ContinuityProjectionScope
} from "./continuity-projection.js";
import type { GraphAssertion, GraphRef } from "./types.js";
import {
  evidenceRefBaseKey,
  graphRefKey
} from "./validation.js";

export const CONTINUITY_CHANGE_LIMITS = Object.freeze({
  maxAggregateStringBytes: 1_048_576,
  maxDepth: 4,
  maxDescriptors: 32_768,
  maxEvidenceRefs: 1_024,
  maxExplainedChanges: 32,
  maxInteractions: 512,
  maxLinks: 1_024,
  maxNestingDepth: 12,
  maxProjectionAssertions: 512,
  maxRawDelta: 128,
  maxResets: 256,
  maxSelectedDeliveries: 96,
  maxSelectedEvidenceRefs: 192,
  maxSelectedInteractions: 64,
  maxSelectedLinks: 96,
  maxSelectedResets: 32,
  maxSelectedUndos: 32,
  maxSourceDeliveries: 512,
  maxSourceRecords: 2_048,
  maxStringBytes: 16_384,
  maxThreads: 128,
  maxUndos: 256,
  maxVisitedRefs: 256
} as const);

export interface ContinuityChangeCandidate {
  readonly additions: readonly GraphAssertion[];
  readonly key: string;
  readonly removals: readonly GraphAssertion[];
  readonly type: "addition" | "removal" | "revision" | "ambiguous";
}

export interface ContinuityPathTree {
  readonly maxDepthReached: number;
  readonly paths: ReadonlyMap<string, readonly ContinuityChangePathStep[]>;
  readonly truncated: boolean;
  readonly visitedRefs: number;
}

const ALLOWED_SUPPORT_CLASSES = new Set<GraphAssertion["epistemicClass"]>([
  "user-asserted",
  "source-observed",
  "deterministic-derived"
]);

function instant(value: string): number {
  return new Date(value).getTime();
}

function inInterval(value: string, after: string, through: string): boolean {
  return instant(value) > instant(after) && instant(value) <= instant(through);
}

export function sameContinuityScope(
  left: ContinuityProjectionScope,
  right: ContinuityProjectionScope
): boolean {
  return left.sourceId === right.sourceId && left.threadId === right.threadId;
}

export function isContinuityNoOp(
  previous: Pick<ContinuityGraphProjection, "sourceVersion">,
  current: Pick<ContinuityGraphProjection, "sourceVersion">
): boolean {
  return previous.sourceVersion === current.sourceVersion;
}

export function classifyContinuityTemporal(
  assertion: GraphAssertion,
  boundary: string,
  current: string
): ContinuityChangeTemporalBasis | undefined {
  if (assertion.validFrom) {
    if (inInterval(assertion.validFrom, boundary, current)) return "world-valid";
    if (instant(assertion.validFrom) <= instant(boundary)) return undefined;
    if (
      instant(assertion.validFrom) > instant(current)
      && inInterval(assertion.recordedAt, boundary, current)
    ) {
      return "learned-after";
    }
    return undefined;
  }
  return inInterval(assertion.recordedAt, boundary, current)
    ? "learned-after"
    : undefined;
}

function sourceVersionsByBase(
  assertion: GraphAssertion
): ReadonlyMap<string, string | undefined> {
  return new Map(
    assertion.sourceRefs.map((ref) => [evidenceRefBaseKey(ref), ref.version])
  );
}

export function continuityRevisionCompatible(
  removed: GraphAssertion,
  added: GraphAssertion
): boolean {
  if (
    removed.predicate !== added.predicate
    || removed.subject.kind !== added.subject.kind
    || removed.object.kind !== added.object.kind
  ) {
    return false;
  }
  if (
    graphRefKey(removed.subject) !== graphRefKey(added.subject)
    && graphRefKey(removed.object) !== graphRefKey(added.object)
  ) {
    return false;
  }
  const oldSources = sourceVersionsByBase(removed);
  const nextSources = sourceVersionsByBase(added);
  const shared = [...oldSources.keys()].filter((key) => nextSources.has(key));
  return shared.length === 1
    && oldSources.get(shared[0] as string) !== nextSources.get(shared[0] as string);
}

export function buildContinuityChangeCandidates(
  removals: readonly GraphAssertion[],
  additions: readonly GraphAssertion[]
): readonly ContinuityChangeCandidate[] {
  const left = [...removals].sort((a, b) => a.id.localeCompare(b.id));
  const right = [...additions].sort((a, b) => a.id.localeCompare(b.id));
  const leftEdges = new Map<string, string[]>();
  const rightEdges = new Map<string, string[]>();
  for (const oldAssertion of left) {
    for (const newAssertion of right) {
      if (!continuityRevisionCompatible(oldAssertion, newAssertion)) continue;
      const oldList = leftEdges.get(oldAssertion.id) ?? [];
      oldList.push(newAssertion.id);
      leftEdges.set(oldAssertion.id, oldList);
      const newList = rightEdges.get(newAssertion.id) ?? [];
      newList.push(oldAssertion.id);
      rightEdges.set(newAssertion.id, newList);
    }
  }
  const leftById = new Map(left.map((item) => [item.id, item]));
  const rightById = new Map(right.map((item) => [item.id, item]));
  const seenLeft = new Set<string>();
  const seenRight = new Set<string>();
  const candidates: ContinuityChangeCandidate[] = [];
  const vertices = [
    ...left.map((item) => ({ id: item.id, side: "left" as const })),
    ...right.map((item) => ({ id: item.id, side: "right" as const }))
  ].sort((a, b) => a.id.localeCompare(b.id) || a.side.localeCompare(b.side));
  for (const vertex of vertices) {
    if (
      (vertex.side === "left" && seenLeft.has(vertex.id))
      || (vertex.side === "right" && seenRight.has(vertex.id))
    ) {
      continue;
    }
    const queue = [vertex];
    const componentLeft = new Set<string>();
    const componentRight = new Set<string>();
    while (queue.length > 0) {
      queue.sort((a, b) => a.id.localeCompare(b.id) || a.side.localeCompare(b.side));
      const current = queue.shift();
      if (!current) break;
      if (current.side === "left") {
        if (seenLeft.has(current.id)) continue;
        seenLeft.add(current.id);
        componentLeft.add(current.id);
        for (const id of [...(leftEdges.get(current.id) ?? [])].sort()) {
          if (!seenRight.has(id)) queue.push({ id, side: "right" });
        }
      } else {
        if (seenRight.has(current.id)) continue;
        seenRight.add(current.id);
        componentRight.add(current.id);
        for (const id of [...(rightEdges.get(current.id) ?? [])].sort()) {
          if (!seenLeft.has(id)) queue.push({ id, side: "left" });
        }
      }
    }
    const componentRemovals = [...componentLeft]
      .map((id) => leftById.get(id))
      .filter((item): item is GraphAssertion => Boolean(item))
      .sort((a, b) => a.id.localeCompare(b.id));
    const componentAdditions = [...componentRight]
      .map((id) => rightById.get(id))
      .filter((item): item is GraphAssertion => Boolean(item))
      .sort((a, b) => a.id.localeCompare(b.id));
    const allIds = [
      ...componentRemovals.map((item) => item.id),
      ...componentAdditions.map((item) => item.id)
    ].sort();
    const type: ContinuityChangeCandidate["type"] =
      componentRemovals.length === 1 && componentAdditions.length === 1
        ? "revision"
        : componentRemovals.length === 0
          ? "addition"
          : componentAdditions.length === 0
            ? "removal"
            : "ambiguous";
    candidates.push(Object.freeze({
      additions: Object.freeze(componentAdditions),
      key: allIds[0] ?? "",
      removals: Object.freeze(componentRemovals),
      type
    }));
  }
  return Object.freeze(candidates.sort((a, b) => a.key.localeCompare(b.key)));
}

function versioned(assertion: GraphAssertion): boolean {
  return assertion.sourceRefs.length > 0
    && assertion.sourceRefs.every((ref) => typeof ref.version === "string");
}

export function continuitySupportEligible(
  assertion: GraphAssertion,
  observedAt: string
): boolean {
  const at = instant(observedAt);
  return ALLOWED_SUPPORT_CLASSES.has(assertion.epistemicClass)
    && versioned(assertion)
    && instant(assertion.recordedAt) <= at
    && (!assertion.validFrom || instant(assertion.validFrom) <= at)
    && (!assertion.validTo || at < instant(assertion.validTo))
    && (!assertion.supersededAt || at < instant(assertion.supersededAt));
}

function pathStep(
  assertion: GraphAssertion,
  direction: "outgoing" | "incoming"
): ContinuityChangePathStep {
  return Object.freeze({
    assertionId: assertion.id,
    derivation: assertion.derivation,
    direction,
    epistemicClass: assertion.epistemicClass,
    object: assertion.object,
    predicate: assertion.predicate,
    sourceRefs: assertion.sourceRefs,
    subject: assertion.subject
  });
}

function pathKey(path: readonly ContinuityChangePathStep[]): string {
  return path.map((step) => step.assertionId).join("\u0000");
}

export function buildContinuityPathTree(
  seed: GraphRef,
  support: readonly GraphAssertion[]
): ContinuityPathTree {
  type Edge = {
    readonly assertion: GraphAssertion;
    readonly direction: "outgoing" | "incoming";
    readonly target: GraphRef;
  };
  const adjacency = new Map<string, Edge[]>();
  for (const assertion of support) {
    const subjectKey = graphRefKey(assertion.subject);
    const objectKey = graphRefKey(assertion.object);
    const outgoing = adjacency.get(subjectKey) ?? [];
    outgoing.push({ assertion, direction: "outgoing", target: assertion.object });
    adjacency.set(subjectKey, outgoing);
    const incoming = adjacency.get(objectKey) ?? [];
    incoming.push({ assertion, direction: "incoming", target: assertion.subject });
    adjacency.set(objectKey, incoming);
  }
  for (const edges of adjacency.values()) {
    edges.sort((a, b) =>
      a.assertion.id.localeCompare(b.assertion.id)
      || graphRefKey(a.target).localeCompare(graphRefKey(b.target))
      || a.direction.localeCompare(b.direction)
    );
  }
  const seedKey = graphRefKey(seed);
  const paths = new Map<string, readonly ContinuityChangePathStep[]>([
    [seedKey, Object.freeze([])]
  ]);
  let frontier: readonly {
    readonly ref: GraphRef;
    readonly path: readonly ContinuityChangePathStep[];
  }[] = [{ ref: seed, path: Object.freeze([]) }];
  let maxDepthReached = 0;
  for (let depth = 0; depth < CONTINUITY_CHANGE_LIMITS.maxDepth - 1; depth += 1) {
    const next: {
      readonly ref: GraphRef;
      readonly path: readonly ContinuityChangePathStep[];
    }[] = [];
    for (const item of frontier) {
      for (const edge of adjacency.get(graphRefKey(item.ref)) ?? []) {
        const targetKey = graphRefKey(edge.target);
        if (paths.has(targetKey)) continue;
        next.push({
          path: Object.freeze([...item.path, pathStep(edge.assertion, edge.direction)]),
          ref: edge.target
        });
      }
    }
    next.sort((a, b) =>
      pathKey(a.path).localeCompare(pathKey(b.path))
      || graphRefKey(a.ref).localeCompare(graphRefKey(b.ref))
    );
    const accepted: typeof next = [];
    for (const item of next) {
      const key = graphRefKey(item.ref);
      if (paths.has(key)) continue;
      if (paths.size >= CONTINUITY_CHANGE_LIMITS.maxVisitedRefs) {
        return Object.freeze({
          maxDepthReached,
          paths,
          truncated: true,
          visitedRefs: paths.size
        });
      }
      paths.set(key, item.path);
      accepted.push(item);
      maxDepthReached = Math.max(maxDepthReached, item.path.length);
    }
    frontier = accepted;
    if (frontier.length === 0) break;
  }
  return Object.freeze({
    maxDepthReached,
    paths,
    truncated: false,
    visitedRefs: paths.size
  });
}

export function explainContinuityPath(
  assertion: GraphAssertion,
  tree: ContinuityPathTree
): readonly ContinuityChangePathStep[] | undefined {
  const choices: {
    readonly path: readonly ContinuityChangePathStep[];
    readonly terminal: string;
  }[] = [];
  for (const [terminal, direction] of [
    [assertion.subject, "outgoing"],
    [assertion.object, "incoming"]
  ] as const) {
    const prefix = tree.paths.get(graphRefKey(terminal));
    if (!prefix) continue;
    choices.push({
      path: Object.freeze([...prefix, pathStep(assertion, direction)]),
      terminal: graphRefKey(terminal)
    });
  }
  choices.sort((a, b) =>
    a.path.length - b.path.length
    || pathKey(a.path).localeCompare(pathKey(b.path))
    || a.terminal.localeCompare(b.terminal)
  );
  return choices[0]?.path;
}
