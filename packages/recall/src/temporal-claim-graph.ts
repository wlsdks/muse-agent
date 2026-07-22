import { createHash } from "node:crypto";
import { posix } from "node:path";
import { isProxy } from "node:util/types";

import { NOTES_CHUNKER_VERSION } from "./notes-chunk.js";
import { NOTES_INDEX_SCHEMA_VERSION } from "./notes-index.js";
import { detectStaleMarker } from "./conflict.js";

export const NOTE_SPAN_IDENTITY_SCHEMA_V1 = "muse.note-span.v1" as const;
export const SUPERSEDES_RELATION_SCHEMA_V1 = "muse.note-relation.supersedes.v1" as const;
export const TEMPORAL_CLAIM_GRAPH_SCHEMA_V1 = "muse.temporal-claim-graph.v1" as const;

export class NoteSpanIdentityError extends Error {
  readonly code = "RECALL_NOTE_SPAN_INVALID" as const;

  constructor() {
    super("Note span identity input is invalid.");
    this.name = "NoteSpanIdentityError";
    this.stack = "NoteSpanIdentityError: Note span identity input is invalid.";
  }
}

const MAX_SOURCE_PATH_BYTES = 512;
const MAX_SOURCE_BYTES = 4 * 1_024 * 1_024;
const MAX_SOURCE_INDEX_CHUNKS = 4_096;
const MAX_SOURCE_INDEX_CHUNK_BYTES = 32 * 1_024;
const MAX_SOURCE_INDEX_UTF8_BYTES = 8 * 1_024 * 1_024;
const MAX_SPAN_BYTES = 4 * 1024;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const TEXT_NOTE_PATH_RE = /\.(?:md|markdown|mkd|mdown|mdx|txt|text|org|rst|adoc|asciidoc)$/iu;
const FATAL_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength"
)?.get;
const NOTE_SPAN_IDENTITY_KEYS = Object.freeze([
  "schema",
  "sourcePath",
  "sourceHash",
  "notesIndexSchema",
  "chunkerVersion",
  "sourceIndexDigest",
  "chunkIndex",
  "chunkHash",
  "start",
  "end",
  "spanHash"
] as const);
const NOTE_SOURCE_INDEX_KEYS = Object.freeze([
  "chunkerVersion",
  "chunks",
  "notesIndexSchema",
  "sourceHash",
  "sourcePath"
] as const);
const NOTE_SOURCE_INDEX_CHUNK_KEYS = Object.freeze(["chunkIndex", "text"] as const);
const CREATE_NOTE_SPAN_IDENTITY_KEYS = Object.freeze([
  "sourceBytes",
  "sourceIndex",
  "chunkIndex",
  "start",
  "end"
] as const);
const RESOLVE_NOTE_SPAN_CURRENT_KEYS = Object.freeze(["sourceBytes", "sourceIndex"] as const);
const CREATE_SUPERSEDES_RELATION_KEYS = Object.freeze(["authoredAt", "current", "edgeId", "stale"] as const);
const RELATION_ENDPOINT_KEYS = Object.freeze(["context", "identity"] as const);
const CREATE_TEMPORAL_CLAIM_GRAPH_KEYS = Object.freeze(["relations"] as const);
const BRANDED_SUPERSEDES_RELATIONS = new WeakSet<object>();
const BRANDED_TEMPORAL_CLAIM_GRAPHS = new WeakSet<object>();
const TEMPORAL_CLAIM_GRAPH_ENDPOINT_LOOKUPS = new WeakMap<
  object,
  ReadonlyMap<string, TemporalClaimGraphEndpointMatchV1>
>();

export interface NoteSourceIndexChunkV1 {
  readonly chunkIndex: number;
  readonly text: string;
}

/**
 * Exact index-time view accepted at the temporal-reference boundary: at most
 * 4,096 chunks, 32 KiB of UTF-8 per chunk, and 8 MiB of UTF-8 in total.
 * These caps do not change ordinary notes indexing or its persisted format.
 */
export interface NoteSourceIndexViewV1 {
  readonly chunkerVersion: typeof NOTES_CHUNKER_VERSION;
  readonly chunks: readonly NoteSourceIndexChunkV1[];
  readonly notesIndexSchema: typeof NOTES_INDEX_SCHEMA_VERSION;
  readonly sourceHash: string;
  readonly sourcePath: string;
}

export interface NoteSpanIdentityV1 {
  readonly schema: typeof NOTE_SPAN_IDENTITY_SCHEMA_V1;
  readonly sourcePath: string;
  readonly sourceHash: string;
  readonly notesIndexSchema: typeof NOTES_INDEX_SCHEMA_VERSION;
  readonly chunkerVersion: typeof NOTES_CHUNKER_VERSION;
  readonly sourceIndexDigest: string;
  readonly chunkIndex: number;
  readonly chunkHash: string;
  readonly start: number;
  readonly end: number;
  readonly spanHash: string;
}

/**
 * Bounded temporal-reference creation input. `sourceBytes` is capped at 4 MiB
 * and `sourceIndex` must satisfy the temporal-reference view caps above.
 * Ordinary notes indexing remains unchanged by these boundary limits.
 */
export interface CreateNoteSpanIdentityV1Input {
  readonly sourceBytes: Uint8Array;
  readonly sourceIndex: NoteSourceIndexViewV1;
  readonly chunkIndex: number;
  readonly start: number;
  readonly end: number;
}

export interface ResolveNoteSpanIdentityV1Current {
  readonly sourceBytes: Uint8Array;
  readonly sourceIndex: NoteSourceIndexViewV1;
}

export type NoteSpanResolutionV1 =
  | { readonly status: "resolved"; readonly span: string }
  | { readonly status: "inert" };

export interface SupersedesRelationEndpointV1 {
  readonly context: ResolveNoteSpanIdentityV1Current;
  readonly identity: NoteSpanIdentityV1;
}

export interface CreateSupersedesRelationV1Input {
  readonly authoredAt: string;
  readonly current: SupersedesRelationEndpointV1;
  readonly edgeId: string;
  readonly stale: SupersedesRelationEndpointV1;
}

export interface SupersedesRelationV1 {
  readonly schema: typeof SUPERSEDES_RELATION_SCHEMA_V1;
  readonly edgeId: string;
  readonly authoredAt: string;
  readonly current: NoteSpanIdentityV1;
  readonly stale: NoteSpanIdentityV1;
}

export interface CreateTemporalClaimGraphV1Input {
  readonly relations: readonly SupersedesRelationV1[];
}

export interface TemporalClaimGraphV1 {
  readonly schema: typeof TEMPORAL_CLAIM_GRAPH_SCHEMA_V1;
  readonly relations: readonly SupersedesRelationV1[];
  readonly semanticDigest: string;
}

export interface TemporalClaimGraphEndpointMatchV1 {
  readonly relation: SupersedesRelationV1;
  readonly role: "current" | "stale";
}

const INERT_RESOLUTION = Object.freeze({ status: "inert" } as const);

function invalid(message: string): never {
  throw new Error(`Invalid note span identity input: ${message}`);
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertCanonicalTextPath(sourcePath: string): void {
  if (typeof sourcePath !== "string") {
    invalid("sourcePath must be a canonical relative UTF-8 text-note path");
  }
  if (sourcePath.length > MAX_SOURCE_PATH_BYTES) {
    invalid("sourcePath must be a canonical relative UTF-8 text-note path");
  }
  const sourcePathBytes = utf8Bytes(sourcePath, "sourcePath");
  const segments = sourcePath.split("/");
  if (
    sourcePath.length === 0
    || sourcePathBytes.byteLength > MAX_SOURCE_PATH_BYTES
    || sourcePath.includes("\0")
    || sourcePath.includes("\\")
    || posix.isAbsolute(sourcePath)
    || /^[a-z]:/iu.test(sourcePath)
    || segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
    || posix.normalize(sourcePath) !== sourcePath
    || !TEXT_NOTE_PATH_RE.test(sourcePath)
  ) {
    invalid("sourcePath must be a canonical relative UTF-8 text-note path");
  }
}

function utf8Bytes(text: string, field: string): Buffer {
  const bytes = Buffer.from(text, "utf8");
  let decoded: string;
  try {
    decoded = FATAL_UTF8_DECODER.decode(bytes);
  } catch {
    return invalid(`${field} must be valid UTF-8 text`);
  }
  if (decoded !== text) {
    invalid(`${field} must contain only valid Unicode scalar values`);
  }
  return bytes;
}

function uint8ArrayByteLength(value: Uint8Array): number {
  if (!TYPED_ARRAY_BYTE_LENGTH_GETTER) {
    return invalid("Uint8Array byteLength intrinsic is unavailable");
  }
  const byteLength: unknown = Reflect.apply(TYPED_ARRAY_BYTE_LENGTH_GETTER, value, []);
  if (typeof byteLength !== "number" || !Number.isSafeInteger(byteLength) || byteLength < 0) {
    return invalid("sourceBytes byteLength is invalid");
  }
  return byteLength;
}

type ExactOwnData<Keys extends readonly string[]> = {
  readonly [Key in Keys[number]]: unknown;
};

function extractExactOwnEnumerableDataProperties<Keys extends readonly string[]>(
  value: unknown,
  expectedKeys: Keys
): ExactOwnData<Keys> | undefined {
  if (isProxy(value)) {
    return undefined;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== expectedKeys.length
    || keys.some((key) => typeof key !== "string" || !expectedKeys.includes(key))
  ) {
    return undefined;
  }
  const extracted = Object.create(null) as Record<Keys[number], unknown>;
  for (const key of expectedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor?.enumerable !== true || !Object.hasOwn(descriptor, "value")) {
      return undefined;
    }
    extracted[key as Keys[number]] = descriptor.value;
  }
  return extracted;
}

function extractSourceIndexData(value: unknown): NoteSourceIndexViewV1 {
  const data = extractExactOwnEnumerableDataProperties(value, NOTE_SOURCE_INDEX_KEYS);
  if (!data) {
    return invalid("sourceIndex must have the exact top-level data schema");
  }
  return {
    chunkerVersion: data.chunkerVersion as typeof NOTES_CHUNKER_VERSION,
    chunks: data.chunks as readonly NoteSourceIndexChunkV1[],
    notesIndexSchema: data.notesIndexSchema as typeof NOTES_INDEX_SCHEMA_VERSION,
    sourceHash: data.sourceHash as string,
    sourcePath: data.sourcePath as string
  };
}

function extractSourceIndexChunkData(value: unknown): NoteSourceIndexChunkV1 {
  const data = extractExactOwnEnumerableDataProperties(value, NOTE_SOURCE_INDEX_CHUNK_KEYS);
  if (!data) {
    return invalid("source-index chunks must have the exact data schema");
  }
  return {
    chunkIndex: data.chunkIndex as number,
    text: data.text as string
  };
}

function extractCanonicalArray(
  value: unknown,
  field: string,
  maxLength?: number
): readonly unknown[] {
  if (isProxy(value)) {
    return invalid(`${field} proxies are not allowed`);
  }
  if (!Array.isArray(value)) {
    return invalid(`${field} must be a canonical array`);
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor?.enumerable !== false
    || !Object.hasOwn(lengthDescriptor, "value")
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
  ) {
    return invalid(`${field} must have only a canonical length and contiguous indices`);
  }
  if (maxLength !== undefined && lengthDescriptor.value > maxLength) {
    return invalid(`${field} exceeds the ${maxLength.toString()}-entry cap`);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== lengthDescriptor.value + 1
    || keys.some((key) => typeof key !== "string")
  ) {
    return invalid(`${field} must have only a canonical length and contiguous indices`);
  }

  const extracted = new Array<unknown>(lengthDescriptor.value);
  for (let index = 0; index < lengthDescriptor.value; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, index.toString());
    if (descriptor?.enumerable !== true || !Object.hasOwn(descriptor, "value")) {
      return invalid(`${field} must have contiguous enumerable data entries`);
    }
    extracted[index] = descriptor.value;
  }
  return extracted;
}

function validateSourceIndex(value: NoteSourceIndexViewV1): NoteSourceIndexViewV1 {
  const sourceIndex = extractSourceIndexData(value);
  if (sourceIndex.notesIndexSchema !== NOTES_INDEX_SCHEMA_VERSION) {
    invalid("notes-index schema does not match the current fixed schema");
  }
  if (sourceIndex.chunkerVersion !== NOTES_CHUNKER_VERSION) {
    invalid("chunker version does not match the current fixed version");
  }
  if (typeof sourceIndex.sourceHash !== "string" || !SHA256_RE.test(sourceIndex.sourceHash)) {
    invalid("source-index sourceHash must be a lowercase SHA-256 digest");
  }
  assertCanonicalTextPath(sourceIndex.sourcePath);
  if (!Array.isArray(sourceIndex.chunks)) {
    invalid("source-index chunks must be an ordered array");
  }

  let previousIndex = -1;
  let sourceIndexUtf8Bytes = 0;
  const chunks: NoteSourceIndexChunkV1[] = [];
  for (const value of extractCanonicalArray(
    sourceIndex.chunks,
    "source-index chunks",
    MAX_SOURCE_INDEX_CHUNKS
  )) {
    const chunk = extractSourceIndexChunkData(value);
    if (!Number.isSafeInteger(chunk.chunkIndex) || chunk.chunkIndex < 0 || chunk.chunkIndex <= previousIndex) {
      invalid("source-index chunk indices must be unique, ordered, and non-negative");
    }
    if (typeof chunk.text !== "string" || chunk.text.length === 0) {
      invalid("source-index chunks must contain non-empty text");
    }
    if (chunk.text.length > MAX_SOURCE_INDEX_CHUNK_BYTES) {
      invalid("source-index chunk text must be at most 32 KiB");
    }
    const chunkBytes = utf8Bytes(chunk.text, "chunk text");
    if (chunkBytes.byteLength > MAX_SOURCE_INDEX_CHUNK_BYTES) {
      invalid("source-index chunk text must be at most 32 KiB");
    }
    sourceIndexUtf8Bytes += chunkBytes.byteLength;
    if (sourceIndexUtf8Bytes > MAX_SOURCE_INDEX_UTF8_BYTES) {
      invalid("source-index chunk text must total at most 8 MiB");
    }
    previousIndex = chunk.chunkIndex;
    chunks.push(chunk);
  }
  return { ...sourceIndex, chunks };
}

function sourceIndexDigest(sourceIndex: NoteSourceIndexViewV1, chunks: readonly NoteSourceIndexChunkV1[]): string {
  return sha256(JSON.stringify({
    chunkerVersion: sourceIndex.chunkerVersion,
    chunks: chunks.map((chunk) => ({
      chunkHash: sha256(chunk.text),
      chunkIndex: chunk.chunkIndex,
      text: chunk.text
    })),
    notesIndexSchema: sourceIndex.notesIndexSchema,
    sourceHash: sourceIndex.sourceHash,
    sourcePath: sourceIndex.sourcePath
  }));
}

function extractCreateInputData(value: unknown): CreateNoteSpanIdentityV1Input {
  const data = extractExactOwnEnumerableDataProperties(value, CREATE_NOTE_SPAN_IDENTITY_KEYS);
  if (!data) {
    return invalid("create input must have the exact data schema");
  }
  return {
    chunkIndex: data.chunkIndex as number,
    end: data.end as number,
    sourceBytes: data.sourceBytes as Uint8Array,
    sourceIndex: data.sourceIndex as NoteSourceIndexViewV1,
    start: data.start as number
  };
}

function extractResolveCurrentData(value: unknown): ResolveNoteSpanIdentityV1Current {
  const data = extractExactOwnEnumerableDataProperties(value, RESOLVE_NOTE_SPAN_CURRENT_KEYS);
  if (!data) {
    return invalid("resolve current context must have the exact data schema");
  }
  return {
    sourceBytes: data.sourceBytes as Uint8Array,
    sourceIndex: data.sourceIndex as NoteSourceIndexViewV1
  };
}

function createResolvedIdentity(value: CreateNoteSpanIdentityV1Input): {
  readonly identity: NoteSpanIdentityV1;
  readonly span: string;
} {
  const input = extractCreateInputData(value);
  if (isProxy(input.sourceBytes)) {
    invalid("sourceBytes proxies are not allowed");
  }
  if (!(input.sourceBytes instanceof Uint8Array)) {
    invalid("sourceBytes must be a Uint8Array");
  }
  if (uint8ArrayByteLength(input.sourceBytes) > MAX_SOURCE_BYTES) {
    invalid("sourceBytes must be at most 4 MiB");
  }
  const sourceBytes = new Uint8Array(input.sourceBytes);
  try {
    FATAL_UTF8_DECODER.decode(sourceBytes);
  } catch {
    invalid("sourceBytes must contain valid UTF-8 text");
  }

  const sourceIndex = validateSourceIndex(input.sourceIndex);
  if (sourceIndex.sourceHash !== sha256(sourceBytes)) {
    invalid("source-index sourceHash does not match the current source bytes");
  }
  const chunks = sourceIndex.chunks;
  if (!Number.isSafeInteger(input.chunkIndex) || input.chunkIndex < 0) {
    invalid("chunkIndex must be a non-negative safe integer");
  }
  const chunk = chunks.find((candidate) => candidate.chunkIndex === input.chunkIndex);
  if (!chunk) {
    invalid("chunkIndex is absent from the ordered source-index view");
  }
  const chunkBytes = utf8Bytes(chunk.text, "chunk text");
  if (
    !Number.isSafeInteger(input.start)
    || !Number.isSafeInteger(input.end)
    || input.start < 0
    || input.start >= input.end
    || input.end > chunkBytes.byteLength
    || input.end - input.start > MAX_SPAN_BYTES
  ) {
    invalid("span must be a non-empty byte range of at most 4 KiB within the chunk");
  }

  let span: string;
  const spanBytes = chunkBytes.subarray(input.start, input.end);
  try {
    span = FATAL_UTF8_DECODER.decode(spanBytes);
  } catch {
    return invalid("span offsets must land on UTF-8 code-point boundaries");
  }

  return {
    identity: Object.freeze({
      chunkHash: sha256(chunkBytes),
      chunkIndex: input.chunkIndex,
      chunkerVersion: NOTES_CHUNKER_VERSION,
      end: input.end,
      notesIndexSchema: NOTES_INDEX_SCHEMA_VERSION,
      schema: NOTE_SPAN_IDENTITY_SCHEMA_V1,
      sourceHash: sourceIndex.sourceHash,
      sourceIndexDigest: sourceIndexDigest(sourceIndex, chunks),
      sourcePath: sourceIndex.sourcePath,
      spanHash: sha256(spanBytes),
      start: input.start
    }),
    span
  };
}

export function createNoteSpanIdentityV1(input: CreateNoteSpanIdentityV1Input): NoteSpanIdentityV1 {
  try {
    return createResolvedIdentity(input).identity;
  } catch {
    throw new NoteSpanIdentityError();
  }
}

function extractIdentityData(value: unknown): NoteSpanIdentityV1 | undefined {
  return extractExactOwnEnumerableDataProperties(value, NOTE_SPAN_IDENTITY_KEYS) as unknown as NoteSpanIdentityV1 | undefined;
}

export function resolveNoteSpanIdentityV1(
  identity: NoteSpanIdentityV1,
  current: ResolveNoteSpanIdentityV1Current
): NoteSpanResolutionV1 {
  try {
    const exactIdentity = extractIdentityData(identity);
    if (!exactIdentity) {
      return INERT_RESOLUTION;
    }
    const exactCurrent = extractResolveCurrentData(current);
    const resolved = createResolvedIdentity({
      chunkIndex: exactIdentity.chunkIndex,
      end: exactIdentity.end,
      sourceBytes: exactCurrent.sourceBytes,
      sourceIndex: exactCurrent.sourceIndex,
      start: exactIdentity.start
    });
    const candidate = resolved.identity;
    if (
      exactIdentity.schema !== candidate.schema
      || exactIdentity.sourcePath !== candidate.sourcePath
      || exactIdentity.sourceHash !== candidate.sourceHash
      || exactIdentity.notesIndexSchema !== candidate.notesIndexSchema
      || exactIdentity.chunkerVersion !== candidate.chunkerVersion
      || exactIdentity.sourceIndexDigest !== candidate.sourceIndexDigest
      || exactIdentity.chunkIndex !== candidate.chunkIndex
      || exactIdentity.chunkHash !== candidate.chunkHash
      || exactIdentity.start !== candidate.start
      || exactIdentity.end !== candidate.end
      || exactIdentity.spanHash !== candidate.spanHash
    ) {
      return INERT_RESOLUTION;
    }
    return Object.freeze({ span: resolved.span, status: "resolved" });
  } catch {
    return INERT_RESOLUTION;
  }
}

/**
 * Resolve an identity against an exact content-addressed notes-index view.
 * The caller is responsible for validating the raw sourceHash represented by
 * that view before granting authority; retrieval uses this after the CLI has
 * already built a validated immutable temporal graph from current source bytes.
 */
export function resolveNoteSpanIdentityV1FromIndex(
  identity: NoteSpanIdentityV1,
  sourceIndexValue: NoteSourceIndexViewV1
): NoteSpanResolutionV1 {
  try {
    const exactIdentity = extractIdentityData(identity);
    if (!exactIdentity) return INERT_RESOLUTION;
    const sourceIndex = validateSourceIndex(sourceIndexValue);
    const chunk = sourceIndex.chunks.find((candidate) => candidate.chunkIndex === exactIdentity.chunkIndex);
    if (!chunk) return INERT_RESOLUTION;
    const chunkBytes = utf8Bytes(chunk.text, "chunk text");
    if (
      !Number.isSafeInteger(exactIdentity.start)
      || !Number.isSafeInteger(exactIdentity.end)
      || exactIdentity.start < 0
      || exactIdentity.start >= exactIdentity.end
      || exactIdentity.end > chunkBytes.byteLength
      || exactIdentity.end - exactIdentity.start > MAX_SPAN_BYTES
    ) return INERT_RESOLUTION;
    let span: string;
    const spanBytes = chunkBytes.subarray(exactIdentity.start, exactIdentity.end);
    try {
      span = FATAL_UTF8_DECODER.decode(spanBytes);
    } catch {
      return INERT_RESOLUTION;
    }
    if (
      exactIdentity.schema !== NOTE_SPAN_IDENTITY_SCHEMA_V1
      || exactIdentity.sourcePath !== sourceIndex.sourcePath
      || exactIdentity.sourceHash !== sourceIndex.sourceHash
      || exactIdentity.notesIndexSchema !== sourceIndex.notesIndexSchema
      || exactIdentity.chunkerVersion !== sourceIndex.chunkerVersion
      || exactIdentity.sourceIndexDigest !== sourceIndexDigest(sourceIndex, sourceIndex.chunks)
      || exactIdentity.chunkHash !== sha256(chunkBytes)
      || exactIdentity.spanHash !== sha256(spanBytes)
    ) return INERT_RESOLUTION;
    return Object.freeze({ span, status: "resolved" });
  } catch {
    return INERT_RESOLUTION;
  }
}

function extractRelationEndpointData(value: unknown): SupersedesRelationEndpointV1 {
  const data = extractExactOwnEnumerableDataProperties(value, RELATION_ENDPOINT_KEYS);
  if (!data) {
    return invalid("relation endpoint must have the exact data schema");
  }
  return {
    context: data.context as ResolveNoteSpanIdentityV1Current,
    identity: data.identity as NoteSpanIdentityV1
  };
}

function resolvedRelationEndpoint(value: unknown): {
  readonly identity: NoteSpanIdentityV1;
  readonly span: string;
} {
  const endpoint = extractRelationEndpointData(value);
  const identity = extractIdentityData(endpoint.identity);
  if (!identity) {
    return invalid("relation endpoint identity must have the exact data schema");
  }
  const resolution = resolveNoteSpanIdentityV1(identity, endpoint.context);
  if (resolution.status !== "resolved") {
    return invalid("relation endpoint must resolve against its exact current context");
  }
  return {
    identity: Object.freeze({ ...identity }),
    span: resolution.span
  };
}

function sameIdentity(left: NoteSpanIdentityV1, right: NoteSpanIdentityV1): boolean {
  return NOTE_SPAN_IDENTITY_KEYS.every((key) => left[key] === right[key]);
}

function createResolvedSupersedesRelation(value: CreateSupersedesRelationV1Input): SupersedesRelationV1 {
  const data = extractExactOwnEnumerableDataProperties(value, CREATE_SUPERSEDES_RELATION_KEYS);
  if (!data) {
    return invalid("relation input must have the exact data schema");
  }
  if (typeof data.edgeId !== "string" || !/^[0-9a-f]{32}$/u.test(data.edgeId)) {
    return invalid("edgeId must be canonical lowercase 128-bit hexadecimal");
  }
  if (
    typeof data.authoredAt !== "string"
    || !Number.isFinite(Date.parse(data.authoredAt))
    || new Date(data.authoredAt).toISOString() !== data.authoredAt
  ) {
    return invalid("authoredAt must be a canonical ISO timestamp");
  }

  const current = resolvedRelationEndpoint(data.current);
  const stale = resolvedRelationEndpoint(data.stale);
  if (
    sameIdentity(current.identity, stale.identity)
    || detectStaleMarker(current.span)
    || !detectStaleMarker(stale.span)
  ) {
    return invalid("relation endpoints must be distinct and preserve current-to-stale marker direction");
  }

  const relation = Object.freeze({
    authoredAt: data.authoredAt,
    current: current.identity,
    edgeId: data.edgeId,
    schema: SUPERSEDES_RELATION_SCHEMA_V1,
    stale: stale.identity
  });
  BRANDED_SUPERSEDES_RELATIONS.add(relation);
  return relation;
}

export function createSupersedesRelationV1(input: CreateSupersedesRelationV1Input): SupersedesRelationV1 {
  try {
    return createResolvedSupersedesRelation(input);
  } catch {
    throw new NoteSpanIdentityError();
  }
}

function canonicalIdentityRecord(identity: NoteSpanIdentityV1): Record<string, string | number> {
  return {
    chunkHash: identity.chunkHash,
    chunkIndex: identity.chunkIndex,
    chunkerVersion: identity.chunkerVersion,
    end: identity.end,
    notesIndexSchema: identity.notesIndexSchema,
    schema: identity.schema,
    sourceHash: identity.sourceHash,
    sourceIndexDigest: identity.sourceIndexDigest,
    sourcePath: identity.sourcePath,
    spanHash: identity.spanHash,
    start: identity.start
  };
}

function canonicalRelationRecord(relation: SupersedesRelationV1) {
  return {
    authoredAt: relation.authoredAt,
    current: canonicalIdentityRecord(relation.current),
    edgeId: relation.edgeId,
    schema: relation.schema,
    stale: canonicalIdentityRecord(relation.stale)
  };
}

function canonicalIdentityKey(identity: NoteSpanIdentityV1): string {
  return JSON.stringify(canonicalIdentityRecord(identity));
}

function createResolvedTemporalClaimGraph(value: CreateTemporalClaimGraphV1Input): TemporalClaimGraphV1 {
  const data = extractExactOwnEnumerableDataProperties(value, CREATE_TEMPORAL_CLAIM_GRAPH_KEYS);
  if (!data) {
    return invalid("graph input must have the exact data schema");
  }
  const rawRelations = extractCanonicalArray(data.relations, "graph relations", 1_024);
  if (rawRelations.some((relation) => typeof relation !== "object" || relation === null || !BRANDED_SUPERSEDES_RELATIONS.has(relation))) {
    return invalid("graph relations must come directly from the relation constructor");
  }

  const relations = rawRelations as SupersedesRelationV1[];
  const edgeIds = new Set(relations.map((relation) => relation.edgeId));
  if (edgeIds.size !== relations.length) {
    return invalid("graph relation edgeIds must be unique");
  }
  const endpointKeys = new Set<string>();
  for (const relation of relations) {
    for (const identity of [relation.current, relation.stale]) {
      const key = canonicalIdentityKey(identity);
      if (endpointKeys.has(key)) {
        return invalid("each graph identity must own exactly one endpoint role");
      }
      endpointKeys.add(key);
    }
  }
  const canonicalRelations = Object.freeze([...relations].sort((left, right) => (
    left.edgeId < right.edgeId ? -1 : left.edgeId > right.edgeId ? 1 : 0
  )));
  const semanticDigest = sha256(JSON.stringify({
    relations: canonicalRelations.map(canonicalRelationRecord),
    schema: TEMPORAL_CLAIM_GRAPH_SCHEMA_V1
  }));
  const graph = Object.freeze({
    relations: canonicalRelations,
    schema: TEMPORAL_CLAIM_GRAPH_SCHEMA_V1,
    semanticDigest
  });
  const endpointLookup = new Map<string, TemporalClaimGraphEndpointMatchV1>();
  for (const relation of canonicalRelations) {
    endpointLookup.set(canonicalIdentityKey(relation.current), Object.freeze({
      relation,
      role: "current"
    }));
    endpointLookup.set(canonicalIdentityKey(relation.stale), Object.freeze({
      relation,
      role: "stale"
    }));
  }
  BRANDED_TEMPORAL_CLAIM_GRAPHS.add(graph);
  TEMPORAL_CLAIM_GRAPH_ENDPOINT_LOOKUPS.set(graph, endpointLookup);
  return graph;
}

export function createTemporalClaimGraphV1(input: CreateTemporalClaimGraphV1Input): TemporalClaimGraphV1 {
  try {
    return createResolvedTemporalClaimGraph(input);
  } catch {
    throw new NoteSpanIdentityError();
  }
}

export function lookupTemporalClaimGraphEndpointV1(
  graph: TemporalClaimGraphV1,
  identity: NoteSpanIdentityV1
): TemporalClaimGraphEndpointMatchV1 | undefined {
  try {
    if (
      typeof graph !== "object"
      || graph === null
      || !BRANDED_TEMPORAL_CLAIM_GRAPHS.has(graph)
    ) {
      return undefined;
    }
    const exactIdentity = extractIdentityData(identity);
    if (!exactIdentity) {
      return undefined;
    }
    return TEMPORAL_CLAIM_GRAPH_ENDPOINT_LOOKUPS
      .get(graph)
      ?.get(canonicalIdentityKey(exactIdentity));
  } catch {
    return undefined;
  }
}
