import {
  createSupersedesRelationV1,
  createTemporalClaimGraphV1,
  resolveNoteSpanIdentityV1,
  type SupersedesRelationV1,
  type TemporalClaimGraphV1
} from "@muse/recall";

import {
  loadBoundedNotesIndex,
  loadIndexedNoteSource,
  type BoundedNotesIndexSnapshot,
  type IndexedNoteSourceResult
} from "./note-relations-context.js";
import {
  readNoteRelationsStore,
  type NoteRelationsPathSnapshot,
  type ReadNoteRelationsStoreResult
} from "./note-relations-store.js";

export type RelationUnavailableReason =
  | "stale_endpoint"
  | "invalid_identity"
  | "marker_direction"
  | "disjoint_conflict";

export type RelationEdgeAudit =
  | { readonly edgeId: string; readonly status: "valid" }
  | { readonly edgeId: string; readonly status: "unavailable"; readonly reason: RelationUnavailableReason };

export interface NoteRelationsAuditResult {
  readonly state: "absent" | "empty" | "valid" | "unavailable";
  readonly revision: number;
  readonly rawDigest: string | null;
  readonly indexRawDigest: string | null;
  readonly semanticDigest: string | null;
  readonly edges: readonly RelationEdgeAudit[];
}

const AUDITED_TEMPORAL_GRAPHS = new WeakMap<object, TemporalClaimGraphV1>();

/** Return graph authority only for the exact valid audit object that minted it. */
export function temporalClaimGraphFromAuditV1(
  audit: NoteRelationsAuditResult
): TemporalClaimGraphV1 | undefined {
  return AUDITED_TEMPORAL_GRAPHS.get(audit);
}

function unavailableEdge(edgeId: string, reason: RelationUnavailableReason): RelationEdgeAudit {
  return Object.freeze({ edgeId, reason, status: "unavailable" });
}

async function auditEndpoint(
  index: BoundedNotesIndexSnapshot,
  identity: SupersedesRelationV1["current"],
  cache: Map<string, Promise<IndexedNoteSourceResult>>
): Promise<{
  readonly result: IndexedNoteSourceResult;
  readonly reason?: RelationUnavailableReason;
}> {
  let pending = cache.get(identity.sourcePath);
  if (!pending) {
    pending = loadIndexedNoteSource(index, identity.sourcePath);
    cache.set(identity.sourcePath, pending);
  }
  const result = await pending;
  if (result.status !== "resolved") {
    return { result, reason: result.reason === "stale_source" ? "stale_endpoint" : "invalid_identity" };
  }
  if (resolveNoteSpanIdentityV1(identity, {
    sourceBytes: result.sourceBytes,
    sourceIndex: result.sourceIndex
  }).status !== "resolved") {
    return { result, reason: "stale_endpoint" };
  }
  return { result };
}

export async function auditNoteRelationsStore(
  paths: NoteRelationsPathSnapshot
): Promise<NoteRelationsAuditResult> {
  const store = await readNoteRelationsStore(paths);
  let index: BoundedNotesIndexSnapshot;
  try {
    index = await loadBoundedNotesIndex(paths);
  } catch {
    return auditLoadedNoteRelationsStore(store, undefined);
  }
  return auditLoadedNoteRelationsStore(store, index);
}

export async function auditLoadedNoteRelationsStore(
  store: ReadNoteRelationsStoreResult,
  index: BoundedNotesIndexSnapshot | undefined
): Promise<NoteRelationsAuditResult> {
  if (store.state === "absent" || store.state === "empty") {
    return Object.freeze({
      edges: Object.freeze([]),
      indexRawDigest: index?.rawDigest ?? null,
      rawDigest: store.rawDigest,
      revision: store.revision,
      semanticDigest: null,
      state: store.state
    });
  }

  if (!index) {
    return Object.freeze({
      edges: Object.freeze(store.relations.map((relation) => unavailableEdge(relation.edgeId, "invalid_identity"))),
      indexRawDigest: null,
      rawDigest: store.rawDigest,
      revision: store.revision,
      semanticDigest: null,
      state: "unavailable"
    });
  }

  const cache = new Map<string, Promise<IndexedNoteSourceResult>>();
  const edges: RelationEdgeAudit[] = [];
  const authoritative: SupersedesRelationV1[] = [];
  for (const relation of store.relations) {
    const [current, stale] = await Promise.all([
      auditEndpoint(index, relation.current, cache),
      auditEndpoint(index, relation.stale, cache)
    ]);
    const endpointReason = current.reason ?? stale.reason;
    if (endpointReason) {
      edges.push(unavailableEdge(relation.edgeId, endpointReason));
      continue;
    }
    try {
      authoritative.push(createSupersedesRelationV1({
        authoredAt: relation.authoredAt,
        current: {
          context: {
            sourceBytes: (current.result as Extract<IndexedNoteSourceResult, { status: "resolved" }>).sourceBytes,
            sourceIndex: (current.result as Extract<IndexedNoteSourceResult, { status: "resolved" }>).sourceIndex
          },
          identity: relation.current
        },
        edgeId: relation.edgeId,
        stale: {
          context: {
            sourceBytes: (stale.result as Extract<IndexedNoteSourceResult, { status: "resolved" }>).sourceBytes,
            sourceIndex: (stale.result as Extract<IndexedNoteSourceResult, { status: "resolved" }>).sourceIndex
          },
          identity: relation.stale
        }
      }));
      edges.push(Object.freeze({ edgeId: relation.edgeId, status: "valid" }));
    } catch {
      edges.push(unavailableEdge(relation.edgeId, "marker_direction"));
    }
  }

  if (edges.some((edge) => edge.status === "unavailable")) {
    return Object.freeze({
      edges: Object.freeze(edges), indexRawDigest: index.rawDigest, rawDigest: store.rawDigest,
      revision: store.revision, semanticDigest: null, state: "unavailable"
    });
  }
  try {
    const graph = createTemporalClaimGraphV1({ relations: authoritative });
    const result = Object.freeze({
      edges: Object.freeze(edges), indexRawDigest: index.rawDigest, rawDigest: store.rawDigest,
      revision: store.revision, semanticDigest: graph.semanticDigest, state: "valid"
    });
    AUDITED_TEMPORAL_GRAPHS.set(result, graph);
    return result;
  } catch {
    return Object.freeze({
      edges: Object.freeze(store.relations.map((relation) => unavailableEdge(relation.edgeId, "disjoint_conflict"))),
      indexRawDigest: index.rawDigest,
      rawDigest: store.rawDigest,
      revision: store.revision,
      semanticDigest: null,
      state: "unavailable"
    });
  }
}
