import { createHash, randomBytes } from "node:crypto";

import {
  createNoteSpanIdentityV1,
  createSupersedesRelationV1,
  createTemporalClaimGraphV1,
  resolveNoteSpanIdentityV1,
  type SupersedesRelationV1
} from "@muse/recall";

import { auditLoadedNoteRelationsStore } from "./note-relations-audit.js";
import {
  NoteRelationsContextError,
  loadBoundedNotesIndex,
  loadIndexedNoteSource
} from "./note-relations-context.js";
import {
  mutateNoteRelationsStore,
  readNoteRelationsStore,
  verifyNoteRelationsRoot,
  type NoteRelationsPathSnapshot,
  type NoteRelationsRootEvidence,
  type ReadNoteRelationsStoreResult
} from "./note-relations-store.js";

export interface RelationSpanRef {
  readonly source: string;
  readonly chunk: number;
  readonly start: number;
  readonly end: number;
}

export interface AddRelationArgs {
  readonly current: RelationSpanRef;
  readonly stale: RelationSpanRef;
}

export class NoteRelationsOperationError extends Error {
  readonly code: "INVALID_REFERENCE" | "GRAPH_UNAVAILABLE" | "CONFIRMATION_STALE" | "NOT_FOUND";

  constructor(code: NoteRelationsOperationError["code"]) {
    super("Note relation operation could not be completed.");
    this.name = "NoteRelationsOperationError";
    this.code = code;
    this.stack = `${this.name}: ${this.message}`;
  }
}

interface PreparedAddEvidence {
  readonly command: "add";
  readonly relation: SupersedesRelationV1;
  readonly currentSpan: string;
  readonly staleSpan: string;
  readonly store: Readonly<{ state: string; revision: number; rawDigest: string | null }>;
  readonly indexRawDigest: string;
  readonly notesRootIdentity: object;
  readonly sourceEvidence: readonly object[];
  readonly rootEvidence: NoteRelationsRootEvidence;
}

export interface PreparedAdd {
  readonly digest: string;
  readonly evidence: PreparedAddEvidence;
}

function canonicalDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function exactSpan(text: string, start: number, end: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= end
    || end > bytes.byteLength || end - start > 4 * 1_024) {
    throw new NoteRelationsOperationError("INVALID_REFERENCE");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(start, end));
  } catch {
    throw new NoteRelationsOperationError("INVALID_REFERENCE");
  }
}

async function reconstructExistingRelations(
  store: ReadNoteRelationsStoreResult,
  index: Awaited<ReturnType<typeof loadBoundedNotesIndex>>
): Promise<readonly SupersedesRelationV1[]> {
  const cache = new Map<string, Awaited<ReturnType<typeof loadIndexedNoteSource>>>();
  const context = async (sourcePath: string) => {
    let loaded = cache.get(sourcePath);
    if (!loaded) {
      loaded = await loadIndexedNoteSource(index, sourcePath);
      cache.set(sourcePath, loaded);
    }
    if (loaded.status !== "resolved") throw new NoteRelationsOperationError("GRAPH_UNAVAILABLE");
    return { sourceBytes: loaded.sourceBytes, sourceIndex: loaded.sourceIndex };
  };
  try {
    const relations: SupersedesRelationV1[] = [];
    for (const relation of store.relations) {
      relations.push(createSupersedesRelationV1({
        authoredAt: relation.authoredAt,
        current: { context: await context(relation.current.sourcePath), identity: relation.current },
        edgeId: relation.edgeId,
        stale: { context: await context(relation.stale.sourcePath), identity: relation.stale }
      }));
    }
    createTemporalClaimGraphV1({ relations });
    return relations;
  } catch (cause) {
    if (cause instanceof NoteRelationsOperationError) throw cause;
    throw new NoteRelationsOperationError("GRAPH_UNAVAILABLE");
  }
}

async function buildPreparedAdd(
  paths: NoteRelationsPathSnapshot,
  args: AddRelationArgs,
  edgeId: string,
  authoredAt: string,
  store: ReadNoteRelationsStoreResult,
  rootEvidence: NoteRelationsRootEvidence
): Promise<PreparedAdd> {
  const index = await loadBoundedNotesIndex(paths);
  const existingRelations = await reconstructExistingRelations(store, index);
  const [current, stale] = await Promise.all([
    loadIndexedNoteSource(index, args.current.source),
    loadIndexedNoteSource(index, args.stale.source)
  ]);
  if (current.status !== "resolved" || stale.status !== "resolved") {
    throw new NoteRelationsOperationError("INVALID_REFERENCE");
  }
  const currentChunk = current.sourceIndex.chunks.find((chunk) => chunk.chunkIndex === args.current.chunk);
  const staleChunk = stale.sourceIndex.chunks.find((chunk) => chunk.chunkIndex === args.stale.chunk);
  if (!currentChunk || !staleChunk) throw new NoteRelationsOperationError("INVALID_REFERENCE");
  let relation: SupersedesRelationV1;
  try {
    const currentIdentity = createNoteSpanIdentityV1({
      sourceBytes: current.sourceBytes, sourceIndex: current.sourceIndex,
      chunkIndex: args.current.chunk, start: args.current.start, end: args.current.end
    });
    const staleIdentity = createNoteSpanIdentityV1({
      sourceBytes: stale.sourceBytes, sourceIndex: stale.sourceIndex,
      chunkIndex: args.stale.chunk, start: args.stale.start, end: args.stale.end
    });
    relation = createSupersedesRelationV1({
      authoredAt,
      current: { context: { sourceBytes: current.sourceBytes, sourceIndex: current.sourceIndex }, identity: currentIdentity },
      edgeId,
      stale: { context: { sourceBytes: stale.sourceBytes, sourceIndex: stale.sourceIndex }, identity: staleIdentity }
    });
  } catch {
    throw new NoteRelationsOperationError("INVALID_REFERENCE");
  }
  try {
    createTemporalClaimGraphV1({ relations: [...existingRelations, relation] });
  } catch {
    throw new NoteRelationsOperationError("GRAPH_UNAVAILABLE");
  }
  const evidence: PreparedAddEvidence = Object.freeze({
    command: "add",
    currentSpan: exactSpan(currentChunk.text, args.current.start, args.current.end),
    indexRawDigest: index.rawDigest,
    notesRootIdentity: index.notesRootIdentity,
    relation,
    rootEvidence,
    sourceEvidence: Object.freeze([current.sourceIdentity, stale.sourceIdentity]),
    staleSpan: exactSpan(staleChunk.text, args.stale.start, args.stale.end),
    store: Object.freeze({ rawDigest: store.rawDigest, revision: store.revision, state: store.state })
  });
  return Object.freeze({ digest: canonicalDigest(evidence), evidence });
}

export async function prepareAddRelation(
  paths: NoteRelationsPathSnapshot,
  args: AddRelationArgs,
  fixed: { readonly edgeId?: string; readonly authoredAt?: string } = {}
): Promise<PreparedAdd> {
  const rootEvidence = await verifyNoteRelationsRoot(paths, { create: false });
  const store = await readNoteRelationsStore(paths);
  const edgeId = fixed.edgeId ?? randomBytes(16).toString("hex");
  const authoredAt = fixed.authoredAt ?? new Date().toISOString();
  return buildPreparedAdd(paths, args, edgeId, authoredAt, store, rootEvidence);
}

export async function commitPreparedAdd(
  paths: NoteRelationsPathSnapshot,
  args: AddRelationArgs,
  prepared: PreparedAdd
): Promise<ReadNoteRelationsStoreResult> {
  try {
    return await mutateNoteRelationsStore(paths, async (store) => {
      const actualRoot = await verifyNoteRelationsRoot(paths, { create: false });
      const evidenceRoot = prepared.evidence.rootEvidence.rootState === "absent"
        ? prepared.evidence.rootEvidence
        : actualRoot;
      const rebuilt = await buildPreparedAdd(
        paths, args, prepared.evidence.relation.edgeId, prepared.evidence.relation.authoredAt, store, evidenceRoot
      );
      if (rebuilt.digest !== prepared.digest) throw new NoteRelationsOperationError("CONFIRMATION_STALE");
      return [...store.relations, rebuilt.evidence.relation];
    }, { expectedRoot: prepared.evidence.rootEvidence });
  } catch (cause) {
    if (cause instanceof NoteRelationsOperationError) throw cause;
    throw new NoteRelationsOperationError("CONFIRMATION_STALE");
  }
}

export interface PreparedRemove {
  readonly digest: string;
  readonly edgeId: string;
  readonly relation: SupersedesRelationV1;
  readonly rootEvidence: NoteRelationsRootEvidence;
  readonly store: Readonly<{ state: string; revision: number; rawDigest: string | null }>;
  readonly auditEvidence: object;
}

async function removeEndpointEvidence(
  indexEvidence: RemoveIndexEvidence,
  identity: SupersedesRelationV1["current"]
): Promise<object> {
  if (indexEvidence.status !== "valid") {
    return Object.freeze({ reason: `index_${indexEvidence.status}`, status: "invalid" });
  }
  const index = indexEvidence.index;
  const loaded = await loadIndexedNoteSource(index, identity.sourcePath);
  if (loaded.status !== "resolved") {
    const status = loaded.reason === "not_indexed" ? "missing"
      : loaded.reason === "unsafe_source" ? "unsafe"
        : loaded.reason === "stale_source" ? "stale" : "invalid";
    return Object.freeze({ reason: loaded.reason, status });
  }
  const resolution = resolveNoteSpanIdentityV1(identity, {
    sourceBytes: loaded.sourceBytes,
    sourceIndex: loaded.sourceIndex
  });
  if (resolution.status !== "resolved") {
    return Object.freeze({ reason: "identity_mismatch", status: "stale" });
  }
  return Object.freeze({
    identity,
    sourceIdentity: loaded.sourceIdentity,
    span: resolution.span,
    status: "resolved"
  });
}

type RemoveIndexEvidence =
  | { readonly status: "valid"; readonly index: Awaited<ReturnType<typeof loadBoundedNotesIndex>> }
  | { readonly status: "missing" | "unsafe" | "corrupt" };

async function loadRemoveIndexEvidence(paths: NoteRelationsPathSnapshot): Promise<RemoveIndexEvidence> {
  try {
    return Object.freeze({ index: await loadBoundedNotesIndex(paths), status: "valid" });
  } catch (cause) {
    if (cause instanceof NoteRelationsContextError) {
      const status = cause.code === "INDEX_MISSING" ? "missing"
        : cause.code === "INDEX_CORRUPT" ? "corrupt" : "unsafe";
      return Object.freeze({ status });
    }
    return Object.freeze({ status: "unsafe" });
  }
}

async function removeAuditEvidence(
  store: ReadNoteRelationsStoreResult,
  relation: SupersedesRelationV1,
  indexEvidence: RemoveIndexEvidence
): Promise<object> {
  const index = indexEvidence.status === "valid" ? indexEvidence.index : undefined;
  const [audit, current, stale] = await Promise.all([
    auditLoadedNoteRelationsStore(store, index),
    removeEndpointEvidence(indexEvidence, relation.current),
    removeEndpointEvidence(indexEvidence, relation.stale)
  ]);
  return Object.freeze({
    current,
    graph: Object.freeze({
      edge: audit.edges.find((edge) => edge.edgeId === relation.edgeId),
      semanticDigest: audit.semanticDigest,
      state: audit.state
    }),
    index: Object.freeze({ rawDigest: index?.rawDigest ?? null, status: indexEvidence.status }),
    stale
  });
}

export async function prepareRemoveRelation(paths: NoteRelationsPathSnapshot, edgeId: string): Promise<PreparedRemove> {
  const rootEvidence = await verifyNoteRelationsRoot(paths, { create: false });
  const store = await readNoteRelationsStore(paths);
  const relation = store.relations.find((candidate) => candidate.edgeId === edgeId);
  if (!relation) throw new NoteRelationsOperationError("NOT_FOUND");
  const indexEvidence = await loadRemoveIndexEvidence(paths);
  const auditEvidence = await removeAuditEvidence(store, relation, indexEvidence);
  const value = {
    auditEvidence,
    command: "remove",
    edgeId,
    relation,
    rootEvidence,
    store: Object.freeze({ rawDigest: store.rawDigest, revision: store.revision, state: store.state })
  } as const;
  return Object.freeze({ ...value, digest: canonicalDigest(value) });
}

export async function commitPreparedRemove(
  paths: NoteRelationsPathSnapshot,
  prepared: PreparedRemove
): Promise<ReadNoteRelationsStoreResult> {
  try {
    return await mutateNoteRelationsStore(paths, async (store) => {
      const relation = store.relations.find((candidate) => candidate.edgeId === prepared.edgeId);
      if (!relation) throw new NoteRelationsOperationError("CONFIRMATION_STALE");
      const indexEvidence = await loadRemoveIndexEvidence(paths);
      const root = await verifyNoteRelationsRoot(paths, { create: false });
      const value = {
        auditEvidence: await removeAuditEvidence(store, relation, indexEvidence),
        command: "remove",
        edgeId: prepared.edgeId,
        relation,
        rootEvidence: root,
        store: { rawDigest: store.rawDigest, revision: store.revision, state: store.state }
      } as const;
      if (canonicalDigest(value) !== prepared.digest) throw new NoteRelationsOperationError("CONFIRMATION_STALE");
      return store.relations.filter((candidate) => candidate.edgeId !== prepared.edgeId);
    }, { expectedRoot: prepared.rootEvidence });
  } catch (cause) {
    if (cause instanceof NoteRelationsOperationError) throw cause;
    throw new NoteRelationsOperationError("CONFIRMATION_STALE");
  }
}
