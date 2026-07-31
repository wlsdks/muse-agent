import { types as nodeTypes } from "node:util";

import {
  CanonicalImmutableEnvelopeError,
  canonicalizeImmutableEnvelope
} from "./canonical-immutable-envelope.js";
import { ACTIVATION_PREDICATES, MAX_ACTIVATION_ESTIMATED_TOKENS } from "./constants.js";
import { AttuneGraphError } from "./attunegraph-error.js";
import type { AttuneGraphStoredProjection } from "./attunegraph-backend.js";
import type {
  AttuneGraph,
  AttuneGraphExecuteCommand,
  AttuneGraphOperatorResult,
  AttuneGraphProjectCommand,
  AttuneGraphScope,
  AttuneGraphSnapshot,
  AttuneGraphSourceFreshness,
  OpenAttuneGraphOptions
} from "./attunegraph-contracts.js";
import { registeredAttuneGraphStoreBackend } from "./attunegraph-store-internal.js";
import { graphRefKey, instantEpoch, normalizeGraphAssertionBatch } from "./validation.js";
import type { GraphAssertion, GraphRef } from "./types.js";

const MAX_WORKING_DEPTH = 2;
const MAX_WORKING_CONSIDERED = 128;
const MAX_WORKING_VISITED = 64;
const MAX_WORKING_ASSERTIONS = 64;
const MAX_STORED_PROJECTION_TEXT = 1_048_576;

type DataRecord = Record<string, unknown>;

interface NormalizedObservation {
  readonly assertionFingerprint: string;
  readonly assertions: readonly GraphAssertion[];
  readonly canonicalProjection: string;
  readonly observationId: string;
  readonly observedAt: string;
  readonly sourceFreshness: AttuneGraphSourceFreshness;
}

function attuneGraphError(code: AttuneGraphError["code"], message: string, options?: ErrorOptions): never {
  throw new AttuneGraphError(code, message, options);
}

function record(
  value: unknown,
  label: string,
  allowed: readonly string[],
  required: readonly string[],
  code: AttuneGraphError["code"] = "INVALID_INPUT"
): DataRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) attuneGraphError(code, `${label} must be a plain object`);
  if (nodeTypes.isProxy(value)) attuneGraphError(code, `${label} must not be a proxy`);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) attuneGraphError(code, `${label} must be a plain object`);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string" || !allowed.includes(key))) attuneGraphError(code, `${label} has unknown fields`);
  if (required.some((key) => !keys.includes(key))) attuneGraphError(code, `${label} has missing fields`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (keys.some((key) => typeof key !== "string" || !descriptors[key] || !("value" in descriptors[key]!))) attuneGraphError(code, `${label} must have data properties`);
  return Object.fromEntries(keys.map((key) => [key, descriptors[key as string]!.value]));
}

function text(value: unknown, label: string, code: AttuneGraphError["code"] = "INVALID_INPUT", limit = 512): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim() || value.length > limit) attuneGraphError(code, `${label} must be bounded non-empty text`);
  return value;
}

function instant(value: unknown, label: string, code: AttuneGraphError["code"] = "INVALID_INPUT"): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) attuneGraphError(code, `${label} must be a canonical ISO instant`);
  return value;
}

export function normalizeAttuneGraphScope(value: unknown, label: string, code: AttuneGraphError["code"] = "INVALID_INPUT"): AttuneGraphScope {
  const input = record(value, label, ["sourceId", "threadId"], ["sourceId", "threadId"], code);
  return Object.freeze({ sourceId: text(input.sourceId, `${label}.sourceId`, code), threadId: text(input.threadId, `${label}.threadId`, code) });
}

function sameScope(left: AttuneGraphScope, right: AttuneGraphScope): boolean {
  return left.sourceId === right.sourceId && left.threadId === right.threadId;
}

function snapshot(value: unknown, label: string, code: AttuneGraphError["code"] = "INVALID_INPUT"): AttuneGraphSnapshot {
  const input = record(value, label, ["schemaVersion", "scope", "generation", "commitId"], ["schemaVersion", "scope", "generation", "commitId"], code);
  if (input.schemaVersion !== 1 || !Number.isSafeInteger(input.generation) || (input.generation as number) < 1) attuneGraphError(code, `${label} is invalid`);
  return Object.freeze({ schemaVersion: 1, scope: normalizeAttuneGraphScope(input.scope, `${label}.scope`, code), generation: input.generation as number, commitId: text(input.commitId, `${label}.commitId`, code) });
}

function freshness(value: unknown, label: string, code: AttuneGraphError["code"] = "INVALID_INPUT"): AttuneGraphSourceFreshness {
  const input = record(value, label, ["state", "observedAt"], ["state", "observedAt"], code);
  if (input.state !== "fresh" && input.state !== "stale" && input.state !== "unknown") attuneGraphError(code, `${label}.state is invalid`);
  return Object.freeze({ state: input.state, observedAt: instant(input.observedAt, `${label}.observedAt`, code) });
}

function freezeSnapshot(input: AttuneGraphSnapshot): AttuneGraphSnapshot {
  return Object.freeze({ schemaVersion: 1, scope: Object.freeze({ ...input.scope }), generation: input.generation, commitId: input.commitId });
}

function canonicalEnvelope(
  value: unknown,
  profile: "external-mutable" | "attunegraph-frozen",
  label: string,
  code: AttuneGraphError["code"] = "INVALID_INPUT"
): { readonly envelope: Readonly<Record<string, unknown>>; readonly canonicalJson: string; readonly contentId: string } {
  try {
    return canonicalizeImmutableEnvelope(value, profile, {
      hashDomain: "attunegraph.canonical-projection.v1",
      idField: "observationId",
      idPrefix: "attunegraph-observation:"
    });
  } catch (cause) {
    throw new AttuneGraphError(code, `${label} is not a safe canonical envelope`, { cause });
  }
}

function dedupeAssertions(
  assertions: readonly GraphAssertion[],
  code: AttuneGraphError["code"]
): readonly GraphAssertion[] {
  const byId = new Map<string, GraphAssertion>();
  for (const assertion of assertions) {
    const existing = byId.get(assertion.id);
    if (existing && JSON.stringify(existing) !== JSON.stringify(assertion)) {
      attuneGraphError(code, `assertion id ${assertion.id} has conflicting content`);
    }
    if (!existing) byId.set(assertion.id, assertion);
  }
  return Object.freeze([...byId.values()].sort((left, right) => left.id.localeCompare(right.id)));
}

function normalizedObservationFromEnvelope(
  envelope: Readonly<Record<string, unknown>>,
  canonicalProjection: string,
  observationId: string,
  expectedScope: AttuneGraphScope,
  code: AttuneGraphError["code"]
): NormalizedObservation {
  const input = record(envelope, "source observation", ["schemaVersion", "observationId", "observationKey", "scope", "observedAt", "sourceFreshness", "assertions"], ["schemaVersion", "observationId", "observationKey", "scope", "observedAt", "sourceFreshness", "assertions"], code);
  if (input.schemaVersion !== 1) attuneGraphError(code, "source observation.schemaVersion must be 1");
  text(input.observationKey, "source observation.observationKey", code);
  const observedScope = normalizeAttuneGraphScope(input.scope, "source observation.scope", code);
  if (!sameScope(observedScope, expectedScope)) attuneGraphError(code === "INVALID_INPUT" ? "INVALID_SCOPE" : code, "source observation must match the opened scope");
  if (!Array.isArray(input.assertions)) attuneGraphError(code, "source observation.assertions must be an array");
  let assertions: readonly GraphAssertion[];
  try {
    assertions = dedupeAssertions(normalizeGraphAssertionBatch(input.assertions), code);
  } catch (cause) {
    if (cause instanceof AttuneGraphError) throw cause;
    throw new AttuneGraphError(code, "source observation assertions are invalid", { cause });
  }
  const derivedId = text(input.observationId, "source observation.observationId", code);
  if (derivedId !== observationId) attuneGraphError(code, "source observation content identifier mismatches its canonical envelope");
  return Object.freeze({
    assertionFingerprint: JSON.stringify(assertions),
    assertions,
    canonicalProjection,
    observationId,
    observedAt: instant(input.observedAt, "source observation.observedAt", code),
    sourceFreshness: freshness(input.sourceFreshness, "source observation.sourceFreshness", code)
  });
}

function normalizeObservation(value: unknown, expectedScope: AttuneGraphScope): NormalizedObservation {
  const canonical = canonicalEnvelope(value, "external-mutable", "source observation");
  return normalizedObservationFromEnvelope(canonical.envelope, canonical.canonicalJson, canonical.contentId, expectedScope, "INVALID_INPUT");
}

function normalizeProject(command: AttuneGraphProjectCommand, expectedScope: AttuneGraphScope): { readonly expectedSnapshot: AttuneGraphSnapshot | undefined; readonly observation: NormalizedObservation } {
  const input = record(command, "project command", ["operator", "observation", "expectedSnapshot"], ["operator", "observation"]);
  if (input.operator !== "canonical-projection@1") attuneGraphError("UNSUPPORTED_OPERATOR", "project supports only canonical-projection@1");
  const expectedSnapshot = input.expectedSnapshot === undefined ? undefined : snapshot(input.expectedSnapshot, "project command.expectedSnapshot");
  if (expectedSnapshot && !sameScope(expectedSnapshot.scope, expectedScope)) attuneGraphError("SNAPSHOT_SCOPE_MISMATCH", "expected snapshot belongs to another scope");
  return Object.freeze({ expectedSnapshot, observation: normalizeObservation(input.observation, expectedScope) });
}

function safeRef(value: unknown): GraphRef {
  const input = record(value, "working graph seed", ["id", "kind"], ["id", "kind"]);
  const validKinds = ["thread", "artifact", "evidence", "delivery", "outcome", "policy", "decision", "action"];
  if (!validKinds.includes(input.kind as string)) attuneGraphError("INVALID_INPUT", "working graph seed.kind is invalid");
  return Object.freeze({ id: text(input.id, "working graph seed.id"), kind: input.kind as GraphRef["kind"] });
}

function normalizeExecute(command: AttuneGraphExecuteCommand): { readonly seed: GraphRef; readonly now: string; readonly maxEstimatedTokens: number } {
  const input = record(command, "execute command", ["operator", "seed", "now", "maxEstimatedTokens"], ["operator", "seed", "now", "maxEstimatedTokens"]);
  if (input.operator !== "working-graph@1") attuneGraphError("UNSUPPORTED_OPERATOR", "execute supports only working-graph@1");
  if (!Number.isSafeInteger(input.maxEstimatedTokens) || (input.maxEstimatedTokens as number) < 1 || (input.maxEstimatedTokens as number) > MAX_ACTIVATION_ESTIMATED_TOKENS) attuneGraphError("INVALID_INPUT", "execute command.maxEstimatedTokens is invalid");
  return Object.freeze({ seed: safeRef(input.seed), now: instant(input.now, "execute command.now"), maxEstimatedTokens: input.maxEstimatedTokens as number });
}

function storeEnvelope(value: unknown): Readonly<Record<string, unknown>> {
  const spec = { hashDomain: "attunegraph.store-projection.v1", idField: "storeEnvelopeId", idPrefix: "attunegraph-store:" };
  try {
    return canonicalizeImmutableEnvelope(value, "external-mutable", spec).envelope;
  } catch (cause) {
    if (!(cause instanceof CanonicalImmutableEnvelopeError) || cause.code !== "PROFILE_MISMATCH") {
      throw new AttuneGraphError("CORRUPT_STORE", "Store returned an unsafe projection", { cause });
    }
  }
  try {
    return canonicalizeImmutableEnvelope(value, "attunegraph-frozen", spec).envelope;
  } catch (cause) {
    throw new AttuneGraphError("CORRUPT_STORE", "Store returned an unsafe projection", { cause });
  }
}

function normalizeStoredProjectionShared(
  value: unknown,
  expectedScope: AttuneGraphScope | undefined
): AttuneGraphStoredProjection {
  const input = record(storeEnvelope(value), "stored projection", ["schemaVersion", "storeEnvelopeId", "snapshot", "observationId", "canonicalProjection", "projectionFingerprint", "observedAt", "sourceFreshness", "assertions"], ["schemaVersion", "storeEnvelopeId", "snapshot", "observationId", "canonicalProjection", "projectionFingerprint", "observedAt", "sourceFreshness", "assertions"], "CORRUPT_STORE");
  if (input.schemaVersion !== 1) {
    if (typeof input.schemaVersion === "number" && input.schemaVersion > 1) attuneGraphError("FUTURE_STORE_STATE", "Store projection schema is newer than this engine");
    attuneGraphError("CORRUPT_STORE", "Store projection schema is invalid");
  }
  const storedSnapshot = snapshot(input.snapshot, "stored projection.snapshot", "CORRUPT_STORE");
  if (expectedScope !== undefined && !sameScope(storedSnapshot.scope, expectedScope)) attuneGraphError("CORRUPT_STORE", "Store projection belongs to another scope");
  const observationId = text(input.observationId, "stored projection.observationId", "CORRUPT_STORE");
  const canonicalProjection = text(input.canonicalProjection, "stored projection.canonicalProjection", "CORRUPT_STORE", MAX_STORED_PROJECTION_TEXT);
  let parsed: unknown;
  try { parsed = JSON.parse(canonicalProjection); } catch (cause) { throw new AttuneGraphError("CORRUPT_STORE", "stored canonical projection is invalid JSON", { cause }); }
  const canonical = canonicalEnvelope(
    parsed,
    "external-mutable",
    "stored canonical projection",
    "CORRUPT_STORE"
  );
  if (canonical.canonicalJson !== canonicalProjection || canonical.contentId !== observationId) attuneGraphError("CORRUPT_STORE", "stored canonical projection fingerprint is invalid");
  const observation = normalizedObservationFromEnvelope(canonical.envelope, canonical.canonicalJson, canonical.contentId, storedSnapshot.scope, "CORRUPT_STORE");
  if (input.projectionFingerprint !== observation.observationId) attuneGraphError("CORRUPT_STORE", "stored projection fingerprint does not match its observation");
  if (storedSnapshot.commitId !== `attunegraph-commit:${observation.observationId}`) attuneGraphError("CORRUPT_STORE", "stored snapshot commit does not match its observation");
  const rawObservedAt = instant(input.observedAt, "stored projection.observedAt", "CORRUPT_STORE");
  const rawFreshness = freshness(input.sourceFreshness, "stored projection.sourceFreshness", "CORRUPT_STORE");
  if (rawObservedAt !== observation.observedAt || JSON.stringify(rawFreshness) !== JSON.stringify(observation.sourceFreshness)) attuneGraphError("CORRUPT_STORE", "stored projection metadata does not match its canonical observation");
  if (!Array.isArray(input.assertions)) attuneGraphError("CORRUPT_STORE", "stored projection.assertions must be an array");
  let rawAssertions: readonly GraphAssertion[];
  try { rawAssertions = dedupeAssertions(normalizeGraphAssertionBatch(input.assertions), "CORRUPT_STORE"); } catch (cause) { if (cause instanceof AttuneGraphError) throw cause; throw new AttuneGraphError("CORRUPT_STORE", "stored projection assertions are invalid", { cause }); }
  if (JSON.stringify(rawAssertions) !== observation.assertionFingerprint) attuneGraphError("CORRUPT_STORE", "stored projection assertions do not match its canonical observation");
  return Object.freeze({
    schemaVersion: 1,
    snapshot: freezeSnapshot(storedSnapshot),
    observationId: observation.observationId,
    canonicalProjection: observation.canonicalProjection,
    projectionFingerprint: observation.observationId,
    observedAt: observation.observedAt,
    sourceFreshness: Object.freeze({ ...observation.sourceFreshness }),
    assertions: Object.freeze([...observation.assertions])
  });
}

export function normalizeStoredProjection(
  value: unknown,
  expectedScope: AttuneGraphScope
): AttuneGraphStoredProjection {
  return normalizeStoredProjectionShared(value, expectedScope);
}

export function normalizeStoredProjectionForPortableDecoder(
  value: unknown
): AttuneGraphStoredProjection {
  return normalizeStoredProjectionShared(value, undefined);
}

function assertionActive(assertion: GraphAssertion, now: string): boolean {
  const epoch = instantEpoch(now);
  return (!assertion.validFrom || instantEpoch(assertion.validFrom) <= epoch)
    && (!assertion.validTo || epoch < instantEpoch(assertion.validTo))
    && instantEpoch(assertion.recordedAt) <= epoch
    && (!assertion.supersededAt || epoch < instantEpoch(assertion.supersededAt));
}

function compareAssertions(left: GraphAssertion, right: GraphAssertion): number {
  return left.predicate.localeCompare(right.predicate) || left.id.localeCompare(right.id);
}

function estimateTokens(value: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(value), "utf8") / 4);
}

function compileWorkingGraph(projection: AttuneGraphStoredProjection, command: ReturnType<typeof normalizeExecute>): AttuneGraphOperatorResult["workingGraph"] & { readonly status: AttuneGraphOperatorResult["status"] } {
  const usable = dedupeAssertions(projection.assertions, "CORRUPT_STORE")
    .filter((assertion) => ACTIVATION_PREDICATES.includes(assertion.predicate) && assertionActive(assertion, command.now))
    .sort(compareAssertions);
  const queue: Array<{ ref: GraphRef; depth: number }> = [{ ref: command.seed, depth: 0 }];
  const visited = new Set<string>([graphRefKey(command.seed)]);
  const selected: GraphAssertion[] = [];
  const selectedIds = new Set<string>();
  let considered = 0;
  let maxDepthReached = 0;
  let traversalTruncated = false;
  let tokenTruncated = false;
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    maxDepthReached = Math.max(maxDepthReached, current.depth);
    const currentKey = graphRefKey(current.ref);
    const reachable = usable.filter((assertion) => graphRefKey(assertion.subject) === currentKey || graphRefKey(assertion.object) === currentKey);
    if (current.depth >= MAX_WORKING_DEPTH) {
      if (reachable.some((assertion) => !selectedIds.has(assertion.id))) traversalTruncated = true;
      continue;
    }
    for (const assertion of reachable) {
      if (selectedIds.has(assertion.id)) continue;
      if (considered >= MAX_WORKING_CONSIDERED || selected.length >= MAX_WORKING_ASSERTIONS) { traversalTruncated = true; break; }
      considered += 1;
      if (estimateTokens({ assertions: [...selected, assertion], seed: command.seed }) > command.maxEstimatedTokens) { tokenTruncated = true; continue; }
      selected.push(assertion);
      selectedIds.add(assertion.id);
      for (const ref of [assertion.subject, assertion.object]) {
        const key = graphRefKey(ref);
        if (!visited.has(key)) {
          if (visited.size >= MAX_WORKING_VISITED) { traversalTruncated = true; continue; }
          visited.add(key);
          queue.push({ ref, depth: current.depth + 1 });
        }
      }
    }
  }
  const refs = [...new Map([command.seed, ...selected.flatMap((assertion) => [assertion.subject, assertion.object])].map((ref) => [graphRefKey(ref), Object.freeze({ ...ref })])).values()].sort((left, right) => graphRefKey(left).localeCompare(graphRefKey(right)));
  const truncationReasons = Object.freeze([...(tokenTruncated ? ["token-budget" as const] : []), ...(traversalTruncated ? ["traversal-budget" as const] : [])]);
  const graph = Object.freeze({ assertions: Object.freeze([...selected]), refs: Object.freeze(refs), seed: Object.freeze({ ...command.seed }), diagnostics: Object.freeze({ consideredAssertions: considered, estimatedTokens: estimateTokens({ assertions: selected, seed: command.seed }), maxDepthReached, visitedRefs: visited.size, truncationReasons }) });
  return Object.freeze({ ...graph, status: truncationReasons.length > 0 ? "partial" as const : selected.length === 0 ? "abstained" as const : "complete" as const });
}

function sameSnapshot(left: AttuneGraphSnapshot | undefined, right: AttuneGraphSnapshot | undefined): boolean {
  return left?.generation === right?.generation && left?.commitId === right?.commitId && left !== undefined && right !== undefined && sameScope(left.scope, right.scope);
}

export async function openAttuneGraph(options: OpenAttuneGraphOptions): Promise<AttuneGraph> {
  const input = record(options, "open AttuneGraph options", ["scope", "store"], ["scope", "store"]);
  const openedScope = normalizeAttuneGraphScope(input.scope, "open AttuneGraph options.scope");
  const backend = registeredAttuneGraphStoreBackend(input.store as OpenAttuneGraphOptions["store"]);
  if (!backend) attuneGraphError("INVALID_INPUT", "store must be created by the backend Adapter seam");
  let lifecycle: "open" | "closing" | "closed" = "open";
  let inFlight = 0;
  let closePromise: Promise<void> | undefined;
  let resolveClose: (() => void) | undefined;
  const release = (): void => {
    inFlight -= 1;
    if (inFlight === 0 && lifecycle === "closing") { lifecycle = "closed"; resolveClose?.(); }
  };
  const begin = <T>(operation: () => Promise<T>): Promise<T> => {
    if (lifecycle !== "open") return Promise.reject(new AttuneGraphError("CLOSED", "AttuneGraph instance is closing or closed"));
    inFlight += 1;
    return Promise.resolve().then(operation).finally(release);
  };
  const read = async (): Promise<AttuneGraphStoredProjection | undefined> => {
    try {
      const raw = await backend.read(openedScope);
      return raw === undefined ? undefined : normalizeStoredProjection(raw, openedScope);
    } catch (cause) {
      if (cause instanceof AttuneGraphError) throw cause;
      throw new AttuneGraphError("STORE_FAILURE", "store read failed", { cause });
    }
  };
  return Object.freeze({
    head(): Promise<AttuneGraphSnapshot | undefined> {
      return begin(async () => {
        const current = await read();
        return current === undefined
          ? undefined
          : freezeSnapshot(current.snapshot);
      });
    },
    project(command: AttuneGraphProjectCommand): Promise<AttuneGraphSnapshot> {
      return begin(async () => {
        const normalized = normalizeProject(command, openedScope);
        const current = await read();
        if (current?.observationId === normalized.observation.observationId) {
          if (current.canonicalProjection !== normalized.observation.canonicalProjection || current.projectionFingerprint !== normalized.observation.observationId) attuneGraphError("CORRUPT_STORE", "stored replay does not match the requested canonical projection");
          return freezeSnapshot(current.snapshot);
        }
        if (
          current
          && Date.parse(normalized.observation.observedAt)
            < Date.parse(current.observedAt)
        ) {
          attuneGraphError(
            "SNAPSHOT_CONFLICT",
            "source observation must not precede the current projection"
          );
        }
        if (normalized.expectedSnapshot && !sameSnapshot(current?.snapshot, normalized.expectedSnapshot)) attuneGraphError("SNAPSHOT_CONFLICT", "expected snapshot is stale");
        if (!normalized.expectedSnapshot && current) attuneGraphError("SNAPSHOT_CONFLICT", "expectedSnapshot is required after the first projection");
        const nextSnapshot = Object.freeze({ schemaVersion: 1 as const, scope: Object.freeze({ ...openedScope }), generation: (current?.snapshot.generation ?? 0) + 1, commitId: `attunegraph-commit:${normalized.observation.observationId}` });
        const proposed: AttuneGraphStoredProjection = Object.freeze({ schemaVersion: 1, snapshot: nextSnapshot, observationId: normalized.observation.observationId, canonicalProjection: normalized.observation.canonicalProjection, projectionFingerprint: normalized.observation.observationId, observedAt: normalized.observation.observedAt, sourceFreshness: Object.freeze({ ...normalized.observation.sourceFreshness }), assertions: Object.freeze([...normalized.observation.assertions]) });
        let committed: unknown;
        try { committed = await backend.compareAndSwap(openedScope, normalized.expectedSnapshot, proposed); } catch (cause) { throw new AttuneGraphError("STORE_FAILURE", "store compare-and-swap failed", { cause }); }
        if (committed !== true && committed !== false) attuneGraphError("CORRUPT_STORE", "store compare-and-swap returned a non-boolean result");
        if (!committed) {
          const winner = await read();
          if (
            winner?.observationId === normalized.observation.observationId
            && winner.canonicalProjection === normalized.observation.canonicalProjection
            && winner.projectionFingerprint === normalized.observation.observationId
          ) {
            return freezeSnapshot(winner.snapshot);
          }
          attuneGraphError("SNAPSHOT_CONFLICT", "projection compare-and-swap failed");
        }
        return freezeSnapshot(nextSnapshot);
      });
    },
    execute(command: AttuneGraphExecuteCommand): Promise<AttuneGraphOperatorResult> {
      return begin(async () => {
        const normalized = normalizeExecute(command);
        const current = await read();
        if (!current) attuneGraphError("SNAPSHOT_CONFLICT", "scope has no committed projection");
        const compiled = compileWorkingGraph(current, normalized);
        return Object.freeze({ operator: "working-graph@1" as const, status: compiled.status, snapshot: freezeSnapshot(current.snapshot), sourceFreshness: Object.freeze({ ...current.sourceFreshness }), workingGraph: Object.freeze({ assertions: compiled.assertions, refs: compiled.refs, seed: compiled.seed, diagnostics: compiled.diagnostics }) });
      });
    },
    close(): Promise<void> {
      if (closePromise) return closePromise;
      lifecycle = "closing";
      closePromise = new Promise<void>((resolve) => { resolveClose = resolve; });
      if (inFlight === 0) { lifecycle = "closed"; resolveClose?.(); }
      return closePromise;
    }
  });
}

/** Compatibility-friendly factory spelling for the lifecycle entry point. */
export const createAttuneGraphEngine = openAttuneGraph;
