import { createHash, type Hash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { TextEncoder } from "node:util";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import {
  createMagStore,
  type MagStoreBackend,
  type MagStoredProjection
} from "./mag-backend.js";
import {
  canonicalizeImmutableEnvelope
} from "./canonical-immutable-envelope.js";
import type { MagScope, MagSnapshot } from "./mag-contracts.js";
import { openMag } from "./mag-engine.js";
import {
  createMagPortableDecoder,
  MagPortableDecoderError,
  type MagPortableDecoderErrorCode,
  type MagPortableDecoderValidationSink
} from "./mag-portable-decoder.js";
import {
  createMagPortableEncoder,
  type MagPortableEncoderBudgetsForInternalUse,
  type MagPortableEncoderIdentitySink,
  type MagPortableProjectionIdentity,
  type MagPortableSummary
} from "./mag-portable-encoder.js";
import type { GraphAssertion } from "./types.js";

const NOW = "2026-07-30T00:00:00.000Z";
const GENERATIONS = 4_096;
const MAX_TRANSPORT_CHUNK_BYTES = 257;
const STREAM_SCOPE = {
  sourceId: "decoder-stream-source",
  threadId: "decoder-stream-thread"
};
const RECORD_SPEC = Object.freeze({
  hashDomain: "muse.mag.portable-record.v1",
  idField: "recordId",
  idPrefix: "mag-portable-record:"
} as const);
const PRODUCTION_BUDGETS: MagPortableEncoderBudgetsForInternalUse = Object.freeze({
  maxProjections: 1_000_000,
  maxHeads: 1_000_000,
  maxScopes: 1_000_000,
  maxTotalRecords: 2_000_002,
  maxPortableLineBytes: 1_114_112,
  maxEdgeLineBytes: 16_384,
  maxArtifactBytes: 1_099_511_627_776
});
const utf8 = new TextEncoder();
const fixtureDirectory = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/portable-v1"
);
const decoderSourcePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "mag-portable-decoder.ts"
);
const qualificationSourcePath = fileURLToPath(import.meta.url);
const caseNames = [
  "empty",
  "one-scope-two-generations",
  "unicode-multi-scope"
] as const;

interface FixtureCase {
  readonly name: (typeof caseNames)[number];
  readonly bytes: Uint8Array;
  readonly projections: readonly MagStoredProjection[];
  readonly report: MagPortableSummary;
}

interface TraceSink {
  readonly value: MagPortableDecoderValidationSink;
  readonly projections: MagPortableProjectionIdentity[];
  readonly heads: MagPortableProjectionIdentity[];
  readonly events: string[];
  readonly aborts: unknown[];
}

type ChunkFactory = (bytes: Uint8Array) => Iterable<Uint8Array>;

let fixtures: readonly FixtureCase[];

beforeAll(async () => {
  const manifest = JSON.parse(
    await readFile(join(fixtureDirectory, "manifest.json"), "utf8")
  ) as {
    readonly cases: readonly {
      readonly case: (typeof caseNames)[number];
      readonly stateId: MagPortableSummary["stateId"];
      readonly exportId: MagPortableSummary["exportId"];
      readonly scopeCount: number;
      readonly projectionCount: number;
      readonly artifactBytes: number;
    }[];
  };
  fixtures = await Promise.all(caseNames.map(async (name) => {
    const [bytes, inputText] = await Promise.all([
      readFile(join(fixtureDirectory, `${name}.magx`)),
      readFile(join(fixtureDirectory, `${name}.input.json`), "utf8")
    ]);
    const input = JSON.parse(inputText) as {
      readonly projections: readonly MagStoredProjection[];
    };
    const ledger = manifest.cases.find((candidate) => candidate.case === name);
    if (ledger === undefined) throw new Error(`missing fixture ledger ${name}`);
    return {
      name,
      bytes,
      projections: input.projections,
      report: {
        format: "muse-mag-portable",
        formatVersion: 1,
        stateId: ledger.stateId,
        exportId: ledger.exportId,
        scopes: ledger.scopeCount,
        projections: ledger.projectionCount,
        bytes: ledger.artifactBytes
      }
    };
  }));
});

function traceSink(): TraceSink {
  const projections: MagPortableProjectionIdentity[] = [];
  const heads: MagPortableProjectionIdentity[] = [];
  const events: string[] = [];
  const aborts: unknown[] = [];
  return {
    projections,
    heads,
    events,
    aborts,
    value: {
      appendProjection(identity) {
        projections.push(identity);
        events.push(`projection:${identity.projectionId}`);
      },
      sealProjections() {
        events.push("seal");
      },
      assertHead(identity) {
        heads.push(identity);
        events.push(`head:${identity.projectionId}`);
      },
      finish(scopeCount, headCount) {
        events.push(`finish:${scopeCount.toString()}:${headCount.toString()}`);
      },
      abort(cause) {
        aborts.push(cause);
        events.push("abort");
      }
    }
  };
}

function* oneChunk(bytes: Uint8Array): Iterable<Uint8Array> {
  yield bytes;
}

function* bytewise(bytes: Uint8Array): Iterable<Uint8Array> {
  for (const byte of bytes) yield Uint8Array.of(byte);
}

function* irregular(bytes: Uint8Array): Iterable<Uint8Array> {
  const pattern = [1, 2, 7, 3, 16, 5, 31, 4, 64, 9] as const;
  let offset = 0;
  let index = 0;
  while (offset < bytes.byteLength) {
    const end = Math.min(
      bytes.byteLength,
      offset + pattern[index % pattern.length]!
    );
    yield bytes.slice(offset, end);
    offset = end;
    index += 1;
  }
}

function utf8Width(lead: number): number {
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  return 1;
}

function* everyLfAndMultibyteBoundary(
  bytes: Uint8Array
): Iterable<Uint8Array> {
  const offsets = new Set<number>([0, bytes.byteLength]);
  for (let index = 0; index < bytes.byteLength;) {
    const byte = bytes[index]!;
    if (byte === 0x0a) {
      offsets.add(index);
      offsets.add(index + 1);
    }
    const width = utf8Width(byte);
    if (width > 1) {
      offsets.add(index);
      for (let inside = 1; inside < width; inside += 1) {
        offsets.add(index + inside);
      }
      offsets.add(index + width);
    }
    index += width;
  }
  const ordered = [...offsets].sort((left, right) => left - right);
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const start = ordered[index]!;
    const end = ordered[index + 1]!;
    if (end > start) yield bytes.slice(start, end);
  }
}

const completeChunkFamilies: readonly {
  readonly name: string;
  readonly chunks: ChunkFactory;
}[] = [
  { name: "one", chunks: oneChunk },
  { name: "bytewise", chunks: bytewise },
  { name: "every-lf-and-multibyte-boundary", chunks: everyLfAndMultibyteBoundary },
  { name: "irregular", chunks: irregular }
];

const failureChunkFamilies = completeChunkFamilies.filter(
  ({ name }) => name === "one" || name === "bytewise" || name === "irregular"
);

async function decodeSuccess(
  bytes: Uint8Array,
  chunks: ChunkFactory
): Promise<{
  readonly report: MagPortableSummary;
  readonly trace: Omit<TraceSink, "value" | "aborts">;
}> {
  const observed = traceSink();
  const decoder = createMagPortableDecoder(observed.value);
  let received = 0;
  for (const chunk of chunks(bytes)) {
    received += chunk.byteLength;
    await decoder.write(chunk);
  }
  expect(received).toBe(bytes.byteLength);
  const report = await decoder.finish();
  expect(observed.aborts).toHaveLength(0);
  return {
    report,
    trace: {
      projections: observed.projections,
      heads: observed.heads,
      events: observed.events
    }
  };
}

function encoderSink(): MagPortableEncoderIdentitySink {
  return {
    appendProjection() {},
    sealProjections() {},
    assertHead() {},
    finish() {},
    abort(cause) {
      throw cause;
    }
  };
}

function rawScopeOrder(
  left: MagStoredProjection,
  right: MagStoredProjection
): number {
  return Buffer.compare(
    Buffer.from(left.snapshot.scope.sourceId, "utf8"),
    Buffer.from(right.snapshot.scope.sourceId, "utf8")
  ) || Buffer.compare(
    Buffer.from(left.snapshot.scope.threadId, "utf8"),
    Buffer.from(right.snapshot.scope.threadId, "utf8")
  );
}

function encodeProjections(
  projections: readonly MagStoredProjection[]
): {
  readonly bytes: Uint8Array;
  readonly report: MagPortableSummary;
} {
  const encoder = createMagPortableEncoder({ identitySink: encoderSink() });
  const chunks: Uint8Array[] = [encoder.start()];
  const heads = new Map<string, MagPortableProjectionIdentity>();
  for (const projection of [...projections].sort(rawScopeOrder)) {
    const appended = encoder.appendProjection(
      projection.snapshot.scope,
      projection
    );
    chunks.push(appended.bytes);
    heads.set(
      `${appended.identity.scope.sourceId}\0${appended.identity.scope.threadId}`,
      appended.identity
    );
  }
  encoder.sealProjections();
  for (const head of heads.values()) {
    chunks.push(encoder.appendHead(
      head.scope,
      head.generation,
      head.commitId,
      head.projectionId
    ));
  }
  const finished = encoder.finish();
  chunks.push(finished.bytes);
  return {
    bytes: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
    report: finished.report
  };
}

function records(bytes: Uint8Array): Record<string, unknown>[] {
  return Buffer.from(bytes)
    .toString("utf8")
    .slice(0, -1)
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function mintedLine(record: Record<string, unknown>): Uint8Array {
  const { recordId: _recordId, ...unsigned } = record;
  const minted = canonicalizeImmutableEnvelope(
    unsigned,
    "external-mutable",
    RECORD_SPEC
  );
  return utf8.encode(`${minted.canonicalJson}\n`);
}

function lines(bytes: Uint8Array): Uint8Array[] {
  return Buffer.from(bytes)
    .toString("utf8")
    .slice(0, -1)
    .split("\n")
    .map((line) => utf8.encode(`${line}\n`));
}

function replaceRecordPrefix(
  bytes: Uint8Array,
  index: number,
  replacement: Record<string, unknown>
): Uint8Array {
  const sourceLines = lines(bytes);
  return Buffer.concat([
    ...sourceLines.slice(0, index).map((line) => Buffer.from(line)),
    Buffer.from(mintedLine(replacement))
  ]);
}

function insertAfter(bytes: Uint8Array, offset: number, inserted: Uint8Array): Uint8Array {
  return Buffer.concat([
    Buffer.from(bytes.slice(0, offset)),
    Buffer.from(inserted),
    Buffer.from(bytes.slice(offset))
  ]);
}

async function rejection(operation: () => Promise<unknown>): Promise<unknown> {
  try {
    await operation();
  } catch (cause) {
    return cause;
  }
  throw new Error("operation did not reject");
}

async function decodeFailure(
  bytes: Uint8Array,
  chunks: ChunkFactory,
  limits?: MagPortableEncoderBudgetsForInternalUse
): Promise<{
  readonly error: {
    readonly name: string;
    readonly code: MagPortableDecoderErrorCode;
    readonly message: string;
  };
  readonly projections: readonly MagPortableProjectionIdentity[];
  readonly heads: readonly MagPortableProjectionIdentity[];
  readonly events: readonly string[];
}> {
  const observed = traceSink();
  const decoder = createMagPortableDecoder(observed.value, limits);
  let failure: unknown;
  for (const chunk of chunks(bytes)) {
    try {
      await decoder.write(chunk);
    } catch (cause) {
      failure = cause;
      break;
    }
  }
  failure ??= await rejection(() => decoder.finish());
  expect(failure).toBeInstanceOf(MagPortableDecoderError);
  expect(observed.aborts).toEqual([failure]);
  const terminalEvents = [...observed.events];
  const terminalProjections = [...observed.projections];
  const terminalHeads = [...observed.heads];
  expect(await rejection(() => decoder.write(new Uint8Array()))).toBe(failure);
  expect(await rejection(() => decoder.finish())).toBe(failure);
  expect(observed.aborts).toEqual([failure]);
  expect(observed.events).toEqual(terminalEvents);
  expect(observed.projections).toEqual(terminalProjections);
  expect(observed.heads).toEqual(terminalHeads);
  const error = failure as MagPortableDecoderError;
  return {
    error: { name: error.name, code: error.code, message: error.message },
    projections: terminalProjections,
    heads: terminalHeads,
    events: terminalEvents
  };
}

function updateIdentityHash(hash: Hash, identity: MagPortableProjectionIdentity): void {
  hash
    .update(identity.scope.sourceId, "utf8")
    .update("\0", "utf8")
    .update(identity.scope.threadId, "utf8")
    .update("\0", "utf8")
    .update(String(identity.generation), "utf8")
    .update("\0", "utf8")
    .update(identity.commitId, "utf8")
    .update("\0", "utf8")
    .update(identity.projectionId, "utf8")
    .update("\0", "utf8");
}

function sameSnapshot(
  left: MagSnapshot | undefined,
  right: MagSnapshot | undefined
): boolean {
  return left?.generation === right?.generation
    && left?.commitId === right?.commitId
    && left?.scope.sourceId === right?.scope.sourceId
    && left?.scope.threadId === right?.scope.threadId;
}

function assertion(scope: MagScope, key: string): GraphAssertion {
  return {
    schemaVersion: 1,
    id: `decoder-stream-${key}`,
    subject: { id: `artifact-${key}`, kind: "artifact" },
    predicate: "LINKED_TO",
    object: { id: scope.threadId, kind: "thread" },
    epistemicClass: "source-observed",
    sourceRefs: [{ id: `source-${key}`, namespace: "test.source" }],
    recordedAt: NOW,
    derivation: { kind: "projection", version: "decoder-qualification@1" }
  };
}

async function writeBounded(
  decoder: ReturnType<typeof createMagPortableDecoder>,
  bytes: Uint8Array,
  artifactHash: Hash
): Promise<void> {
  artifactHash.update(bytes);
  for (let offset = 0; offset < bytes.byteLength; offset += MAX_TRANSPORT_CHUNK_BYTES) {
    const chunk = bytes.slice(
      offset,
      Math.min(bytes.byteLength, offset + MAX_TRANSPORT_CHUNK_BYTES)
    );
    expect(chunk.byteLength).toBeLessThanOrEqual(MAX_TRANSPORT_CHUNK_BYTES);
    await decoder.write(chunk);
  }
}

async function decoderNonRetentionSmoke(): Promise<{
  readonly encoderReport: MagPortableSummary;
  readonly decoderReport: MagPortableSummary;
  readonly artifactDigest: string;
  readonly encoderIdentityDigest: string;
  readonly decoderIdentityDigest: string;
  readonly encoderIdentityCount: number;
  readonly decoderIdentityCount: number;
  readonly finalHead: MagPortableProjectionIdentity;
  readonly retainedState: {
    readonly producerCurrentProjections: 1;
    readonly producerExpectedSnapshots: 1;
    readonly encoderSinkLastIdentities: 1;
    readonly decoderSinkLastIdentities: 1;
    readonly maxTransportChunkBytes: 257;
  };
}> {
  let current: MagStoredProjection | undefined;
  let expectedSnapshot: MagSnapshot | undefined;
  let encoderLast: MagPortableProjectionIdentity | undefined;
  let decoderLast: MagPortableProjectionIdentity | undefined;
  let encoderIdentityCount = 0;
  let decoderIdentityCount = 0;
  let decoderHeadCount = 0;
  let decoderAbortCount = 0;
  const encoderIdentityHash = createHash("sha256");
  const decoderIdentityHash = createHash("sha256");
  const artifactHash = createHash("sha256");

  const decoder = createMagPortableDecoder({
    appendProjection(identity) {
      expect(identity.generation).toBe(decoderIdentityCount + 1);
      decoderLast = identity;
      decoderIdentityCount += 1;
      updateIdentityHash(decoderIdentityHash, identity);
    },
    sealProjections() {},
    assertHead(identity) {
      expect(identity).toEqual(decoderLast);
      decoderHeadCount += 1;
    },
    finish(scopeCount, headCount) {
      expect(scopeCount).toBe(1);
      expect(headCount).toBe(1);
      expect(decoderHeadCount).toBe(1);
    },
    abort() {
      decoderAbortCount += 1;
    }
  });
  const encoder = createMagPortableEncoder({
    identitySink: {
      appendProjection(identity) {
        encoderLast = identity;
        encoderIdentityCount += 1;
        updateIdentityHash(encoderIdentityHash, identity);
      },
      sealProjections() {},
      assertHead(identity) {
        expect(identity).toEqual(encoderLast);
      },
      finish(scopeCount, headCount) {
        expect(scopeCount).toBe(1);
        expect(headCount).toBe(1);
      },
      abort(cause) {
        throw cause;
      }
    }
  });
  await writeBounded(decoder, encoder.start(), artifactHash);

  const backend: MagStoreBackend = {
    async read() {
      return current === undefined
        ? undefined
        : JSON.parse(JSON.stringify(current)) as MagStoredProjection;
    },
    async compareAndSwap(_scope, expected, proposed) {
      if (!sameSnapshot(current?.snapshot, expected)) return false;
      const appended = encoder.appendProjection(
        STREAM_SCOPE,
        JSON.parse(JSON.stringify(proposed)) as MagStoredProjection
      );
      await writeBounded(decoder, appended.bytes, artifactHash);
      current = proposed;
      return true;
    }
  };
  const mag = await openMag({
    scope: STREAM_SCOPE,
    store: createMagStore(backend)
  });
  try {
    for (let generation = 1; generation <= GENERATIONS; generation += 1) {
      const key = generation.toString(16).padStart(4, "0");
      expectedSnapshot = await mag.project({
        operator: "canonical-projection@1",
        expectedSnapshot,
        observation: {
          schemaVersion: 1,
          observationKey: key,
          scope: STREAM_SCOPE,
          observedAt: NOW,
          sourceFreshness: { state: "fresh", observedAt: NOW },
          assertions: [assertion(STREAM_SCOPE, key)]
        }
      });
      expect(current?.snapshot).toEqual(expectedSnapshot);
      expect(encoderIdentityCount).toBe(generation);
      expect(decoderIdentityCount).toBe(generation);
    }
  } finally {
    await mag.close();
  }

  if (
    current === undefined
    || expectedSnapshot === undefined
    || encoderLast === undefined
    || decoderLast === undefined
  ) {
    throw new Error("decoder streaming smoke did not retain final bounded state");
  }
  encoder.sealProjections();
  await writeBounded(
    decoder,
    encoder.appendHead(
      encoderLast.scope,
      encoderLast.generation,
      encoderLast.commitId,
      encoderLast.projectionId
    ),
    artifactHash
  );
  const encoderFinished = encoder.finish();
  await writeBounded(decoder, encoderFinished.bytes, artifactHash);
  const decoderReport = await decoder.finish();

  expect(decoderAbortCount).toBe(0);
  expect(encoderIdentityCount).toBe(GENERATIONS);
  expect(decoderIdentityCount).toBe(GENERATIONS);
  expect(decoderLast).toEqual(encoderLast);
  expect(current.snapshot).toEqual(expectedSnapshot);

  return {
    encoderReport: encoderFinished.report,
    decoderReport,
    artifactDigest: artifactHash.digest("hex"),
    encoderIdentityDigest: encoderIdentityHash.digest("hex"),
    decoderIdentityDigest: decoderIdentityHash.digest("hex"),
    encoderIdentityCount,
    decoderIdentityCount,
    finalHead: decoderLast,
    retainedState: {
      producerCurrentProjections: 1,
      producerExpectedSnapshots: 1,
      encoderSinkLastIdentities: 1,
      decoderSinkLastIdentities: 1,
      maxTransportChunkBytes: MAX_TRANSPORT_CHUNK_BYTES
    }
  };
}

const REVIEWED_DECODER_TOP_LEVEL_DECLARATIONS = Object.freeze([
  "const sink = captureSink(validationSink);",
  "const budgets = decoderBudgets(qualificationLimits);",
  'let phase: DecoderPhase = "manifest";',
  "let currentLine: number[] = [];",
  "let artifactBytes = 0;",
  "let priorByteLength = 0;",
  "let recordCount = 0;",
  "let projectionCount = 0;",
  "let headCount = 0;",
  "let manifestId: string | undefined;",
  "let stateHash: Hash | undefined;",
  "let lastProjection: MagPortableProjectionIdentity | undefined;",
  "let lastHeadScope: MagScope | undefined;",
  "let report: MagPortableSummary | undefined;",
  "let apiFinished = false;",
  "let operationActive = false;",
  "let terminalPinned = false;",
  "let terminalFailure: unknown;",
  "let engaged = false;",
  "let abortPromise: Promise<void> | undefined;",
  "const abortOnce = (): Promise<void> => {",
  "const checkpoint = async (): Promise<void> => {",
  "const pinFailure = async (cause: unknown): Promise<never> => {",
  "const invokeSink = async <Name extends SinkMethodName>(",
  "const sealIfNeeded = async (): Promise<void> => {",
  "const commitNonFooterLine = (",
  "const processManifest = (record: JsonRecord, lineWithLf: Uint8Array): void => {",
  "const processProjection = async (",
  "const processHead = async (",
  "const processFooter = async (",
  "const processLine = async (lineBytes: Uint8Array): Promise<void> => {",
  "const processChunk = async (chunk: Uint8Array): Promise<void> => {",
  "const run = <Result>("
]);

const REVIEWED_DECODER_DATA_LEDGER = Object.freeze({
  sink: "fixed captured receiver and five methods",
  budgets: "fixed scalar limits object",
  phase: "one fixed enum",
  currentLine: "only variable-size retained container; configured line guard",
  artifactBytes: "one scalar",
  priorByteLength: "one scalar",
  recordCount: "one scalar",
  projectionCount: "one scalar",
  headCount: "one scalar",
  manifestId: "one bounded identity",
  stateHash: "one incremental SHA-256 state",
  lastProjection: "one bounded prior-order identity",
  lastHeadScope: "one bounded prior-order scope",
  report: "one fixed summary after footer",
  apiFinished: "one boolean",
  operationActive: "one boolean",
  terminalPinned: "one boolean",
  terminalFailure: "one terminal value",
  engaged: "one boolean",
  abortPromise: "one terminal promise"
});

const REVIEWED_SMOKE_DATA_LEDGER = Object.freeze({
  producer: Object.freeze([
    "current",
    "expectedSnapshot"
  ]),
  encoderSink: Object.freeze([
    "encoderLast",
    "encoderIdentityCount",
    "encoderIdentityHash"
  ]),
  decoderSink: Object.freeze([
    "decoderLast",
    "decoderIdentityCount",
    "decoderHeadCount",
    "decoderAbortCount",
    "decoderIdentityHash"
  ]),
  transport: Object.freeze([
    "artifactHash"
  ]),
  fixedOrchestration: Object.freeze([
    "decoder",
    "encoder",
    "backend",
    "mag",
    "encoderFinished",
    "decoderReport"
  ])
});

const REVIEWED_SMOKE_TOP_LEVEL_DECLARATIONS = Object.freeze([
  "let current: MagStoredProjection | undefined;",
  "let expectedSnapshot: MagSnapshot | undefined;",
  "let encoderLast: MagPortableProjectionIdentity | undefined;",
  "let decoderLast: MagPortableProjectionIdentity | undefined;",
  "let encoderIdentityCount = 0;",
  "let decoderIdentityCount = 0;",
  "let decoderHeadCount = 0;",
  "let decoderAbortCount = 0;",
  'const encoderIdentityHash = createHash("sha256");',
  'const decoderIdentityHash = createHash("sha256");',
  'const artifactHash = createHash("sha256");',
  "const decoder = createMagPortableDecoder({",
  "const encoder = createMagPortableEncoder({",
  "const backend: MagStoreBackend = {",
  "const mag = await openMag({",
  "const encoderFinished = encoder.finish();",
  "const decoderReport = await decoder.finish();"
]);

function sourceRegion(
  source: string,
  startMarker: string,
  endMarker?: string
): string {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`missing source marker: ${startMarker}`);
  if (endMarker === undefined) return source.slice(start);
  const end = source.indexOf(endMarker, start);
  if (end < 0) throw new Error(`missing source marker: ${endMarker}`);
  return source.slice(start, end);
}

function topLevelDeclarationLines(source: string): readonly string[] {
  return source
    .split("\n")
    .filter((line) => /^ {2}(?:const|let) [A-Za-z_$][\w$]*/u.test(line))
    .map((line) => line.trim());
}

function declarationName(line: string): string {
  const match = /^(?:const|let) ([A-Za-z_$][\w$]*)/u.exec(line);
  if (match === null) throw new Error(`not a declaration: ${line}`);
  return match[1]!;
}

function retainedAccumulatorNames(
  source: string,
  topLevelDeclarations: readonly string[]
): readonly string[] {
  const topLevelNames = new Set(topLevelDeclarations.map(declarationName));
  const variableContainerDeclarations = topLevelDeclarations
    .filter((line) =>
      /(?:\[\]|Array<|=\s*\[|new (?:Map|Set|WeakMap|WeakSet)\b|Object\.create\(|=\s*["'`]["'`])/u
        .test(line)
    )
    .map(declarationName);
  const mutatedContainers = [...source.matchAll(
    /\b([A-Za-z_$][\w$]*)\.(?:push|unshift|splice|set|add)\s*\(/gu
  )]
    .map((match) => match[1]!)
    .filter((name) => topLevelNames.has(name));
  return [...new Set([
    ...variableContainerDeclarations,
    ...mutatedContainers
  ])].sort();
}

function decoderRetentionAudit(source: string): readonly string[] {
  const body = sourceRegion(source, "export function createMagPortableDecoder");
  const declarations = topLevelDeclarationLines(body);
  const failures: string[] = [];
  if (
    JSON.stringify(declarations)
    !== JSON.stringify(REVIEWED_DECODER_TOP_LEVEL_DECLARATIONS)
  ) {
    failures.push("decoder top-level declarations differ from closed ledger");
  }
  if (
    JSON.stringify(retainedAccumulatorNames(body, declarations))
    !== JSON.stringify(["currentLine"])
  ) {
    failures.push("decoder retained accumulators are not exactly currentLine");
  }
  if (
    !body.includes(
      "const maxLineBytes = recordCount === 0\n"
      + "        ? budgets.maxEdgeLineBytes\n"
      + "        : budgets.maxPortableLineBytes;"
    )
    || !body.includes("if (currentLine.length >= maxLineBytes)")
    || !body.includes("currentLine.push(byte);")
    || !body.includes("currentLine = [];")
  ) {
    failures.push("currentLine is not tied to its configured line guard");
  }
  return failures;
}

function smokeRetentionAudit(source: string): readonly string[] {
  const body = sourceRegion(
    source,
    "async function decoderNonRetentionSmoke",
    "\nconst REVIEWED_DECODER_TOP_LEVEL_DECLARATIONS"
  );
  const declarations = topLevelDeclarationLines(body);
  const failures: string[] = [];
  if (
    JSON.stringify(declarations)
    !== JSON.stringify(REVIEWED_SMOKE_TOP_LEVEL_DECLARATIONS)
  ) {
    failures.push("smoke top-level declarations differ from closed ledger");
  }
  if (retainedAccumulatorNames(body, declarations).length !== 0) {
    failures.push("smoke helper retains a variable-size accumulator");
  }
  const reviewedNames = Object.values(REVIEWED_SMOKE_DATA_LEDGER).flat().sort();
  const actualNames = declarations.map(declarationName).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(reviewedNames)) {
    failures.push("smoke role ledger differs from exact retained declarations");
  }
  return failures;
}

describe("MAG portable decoder qualification", () => {
  it("keeps checked fixtures and production round-trips exact across every chunk family", async () => {
    for (const fixture of fixtures) {
      const baseline = await decodeSuccess(fixture.bytes, oneChunk);
      expect(baseline.report).toEqual(fixture.report);
      for (const family of completeChunkFamilies) {
        const decoded = await decodeSuccess(fixture.bytes, family.chunks);
        expect(decoded, `${fixture.name}:${family.name}`).toEqual(baseline);
      }
    }

    const unicode = fixtures.find(
      (fixture) => fixture.name === "unicode-multi-scope"
    )!;
    const variants: readonly {
      readonly name: string;
      readonly projections: readonly MagStoredProjection[];
    }[] = [
      {
        name: "empty",
        projections: []
      },
      {
        name: "two-generation",
        projections: fixtures.find(
          (fixture) => fixture.name === "one-scope-two-generations"
        )!.projections
      },
      {
        name: "normalization-distinct",
        projections: unicode.projections.filter(({ snapshot }) =>
          snapshot.scope.sourceId === "e\u0301"
          || snapshot.scope.sourceId === "\u00e9"
        )
      },
      {
        name: "raw-utf8-u+e000-u+10000",
        projections: unicode.projections.filter(({ snapshot }) =>
          snapshot.scope.sourceId === "\ue000"
          || snapshot.scope.sourceId === "\u{10000}"
        )
      }
    ];
    for (const variant of variants) {
      const encoded = encodeProjections(variant.projections);
      const baseline = await decodeSuccess(encoded.bytes, oneChunk);
      expect(baseline.report).toEqual(encoded.report);
      for (const family of completeChunkFamilies) {
        expect(
          await decodeSuccess(encoded.bytes, family.chunks),
          `${variant.name}:${family.name}`
        ).toEqual(baseline);
      }
    }
  }, 120_000);

  it("pins exact post-engagement failures across one, bytewise, and irregular chunks", async () => {
    const two = fixtures.find(
      (fixture) => fixture.name === "one-scope-two-generations"
    )!;
    const unicode = fixtures.find(
      (fixture) => fixture.name === "unicode-multi-scope"
    )!;
    const twoLines = lines(two.bytes);
    const twoRecords = records(two.bytes);
    const afterFirstProjection = twoLines[0]!.byteLength + twoLines[1]!.byteLength;
    const invalidUtf8 = Uint8Array.from(unicode.bytes);
    const unicodeLf = [...invalidUtf8.entries()]
      .filter(([, byte]) => byte === 0x0a)
      .map(([index]) => index);
    const secondProjectionStart = unicodeLf[1]! + 1;
    const thirdProjectionStart = unicodeLf[2]!;
    const invalidOffset = invalidUtf8.findIndex(
      (byte, index) =>
        index >= secondProjectionStart
        && index < thirdProjectionStart
        && byte >= 0x80
    );
    expect(invalidOffset).toBeGreaterThan(secondProjectionStart);
    invalidUtf8[invalidOffset] = 0xff;

    const overlongSecondProjection = Buffer.concat([
      Buffer.from(twoLines[0]!),
      Buffer.from(twoLines[1]!),
      Buffer.from(twoLines[2]!.slice(0, -1)),
      Buffer.from(" "),
      Buffer.from("\n")
    ]);
    const failureCases: readonly {
      readonly name: string;
      readonly bytes: Uint8Array;
      readonly limits?: MagPortableEncoderBudgetsForInternalUse;
      readonly code: MagPortableDecoderErrorCode;
    }[] = [
      {
        name: "split-invalid-utf8",
        bytes: invalidUtf8,
        code: "CORRUPT_PORTABLE_EXPORT"
      },
      {
        name: "cr-line",
        bytes: insertAfter(two.bytes, afterFirstProjection, utf8.encode("\r")),
        code: "CORRUPT_PORTABLE_EXPORT"
      },
      {
        name: "blank-line",
        bytes: insertAfter(two.bytes, afterFirstProjection, utf8.encode("\n")),
        code: "CORRUPT_PORTABLE_EXPORT"
      },
      {
        name: "line-limit-crossing",
        bytes: overlongSecondProjection,
        limits: { ...PRODUCTION_BUDGETS, maxPortableLineBytes: 1_938 },
        code: "LIMIT_EXCEEDED"
      },
      {
        name: "artifact-limit-crossing",
        bytes: two.bytes,
        limits: {
          ...PRODUCTION_BUDGETS,
          maxArtifactBytes: afterFirstProjection + 17
        },
        code: "LIMIT_EXCEEDED"
      },
      {
        name: "corrupt-projection-after-engagement",
        bytes: replaceRecordPrefix(two.bytes, 2, {
          ...twoRecords[2],
          sequence: 1
        }),
        code: "CORRUPT_PORTABLE_EXPORT"
      },
      {
        name: "head-corruption",
        bytes: replaceRecordPrefix(two.bytes, 3, {
          ...twoRecords[3],
          sequence: 2
        }),
        code: "CORRUPT_PORTABLE_EXPORT"
      },
      {
        name: "footer-corruption",
        bytes: replaceRecordPrefix(two.bytes, 4, {
          ...twoRecords[4],
          stateId: `mag-state:${"0".repeat(64)}`
        }),
        code: "CORRUPT_PORTABLE_EXPORT"
      },
      {
        name: "bytes-after-footer",
        bytes: Buffer.concat([Buffer.from(two.bytes), Buffer.from("x")]),
        code: "CORRUPT_PORTABLE_EXPORT"
      }
    ];
    for (const failureCase of failureCases) {
      const baseline = await decodeFailure(
        failureCase.bytes,
        oneChunk,
        failureCase.limits
      );
      expect(baseline.error.code).toBe(failureCase.code);
      for (const family of failureChunkFamilies) {
        expect(
          await decodeFailure(
            failureCase.bytes,
            family.chunks,
            failureCase.limits
          ),
          `${failureCase.name}:${family.name}`
        ).toEqual(baseline);
      }
    }
  }, 120_000);

  it("closes decoder and qualification-helper retained-data ledgers", async () => {
    const [decoderSource, qualificationSource] = await Promise.all([
      readFile(decoderSourcePath, "utf8"),
      readFile(qualificationSourcePath, "utf8")
    ]);
    expect(Object.keys(REVIEWED_DECODER_DATA_LEDGER)).toEqual(
      REVIEWED_DECODER_TOP_LEVEL_DECLARATIONS
        .slice(0, Object.keys(REVIEWED_DECODER_DATA_LEDGER).length)
        .map(declarationName)
    );
    expect(decoderRetentionAudit(decoderSource)).toEqual([]);
    expect(smokeRetentionAudit(qualificationSource)).toEqual([]);

    const decoderHistoryMutation = decoderSource
      .replace(
        "  let phase: DecoderPhase = \"manifest\";",
        "  const retainedRecords: JsonRecord[] = [];\n"
        + "  let phase: DecoderPhase = \"manifest\";"
      )
      .replace(
        "    const kind = record.kind;",
        "    const kind = record.kind;\n"
        + "    retainedRecords.push(record);"
      );
    expect(decoderHistoryMutation).toContain("retainedRecords.push(record)");
    expect(decoderRetentionAudit(decoderHistoryMutation)).toContain(
      "decoder top-level declarations differ from closed ledger"
    );
    expect(decoderRetentionAudit(decoderHistoryMutation)).toContain(
      "decoder retained accumulators are not exactly currentLine"
    );

    const projectionHistoryMutation = qualificationSource
      .replace(
        "  let current: MagStoredProjection | undefined;",
        "  const retainedProjectionHistory: MagStoredProjection[] = [];\n"
        + "  let current: MagStoredProjection | undefined;"
      )
      .replace(
        "      const appended = encoder.appendProjection(",
        "      retainedProjectionHistory.push(proposed);\n"
        + "      const appended = encoder.appendProjection("
      );
    expect(projectionHistoryMutation).toContain(
      "retainedProjectionHistory.push(proposed)"
    );
    expect(smokeRetentionAudit(projectionHistoryMutation)).toContain(
      "smoke top-level declarations differ from closed ledger"
    );
    expect(smokeRetentionAudit(projectionHistoryMutation)).toContain(
      "smoke helper retains a variable-size accumulator"
    );

    const identityHistoryMutation = qualificationSource
      .replace(
        "  let encoderLast: MagPortableProjectionIdentity | undefined;",
        "  const retainedIdentityHistory: MagPortableProjectionIdentity[] = [];\n"
        + "  let encoderLast: MagPortableProjectionIdentity | undefined;"
      )
      .replace(
        "      decoderLast = identity;",
        "      retainedIdentityHistory.push(identity);\n"
        + "      decoderLast = identity;"
      );
    expect(identityHistoryMutation).toContain(
      "retainedIdentityHistory.push(identity)"
    );
    expect(smokeRetentionAudit(identityHistoryMutation)).toContain(
      "smoke top-level declarations differ from closed ledger"
    );
    expect(smokeRetentionAudit(identityHistoryMutation)).toContain(
      "smoke helper retains a variable-size accumulator"
    );
  });

  it("corroborates bounded decoder non-retention with two exact 4,096-generation runs", async () => {
    const first = await decoderNonRetentionSmoke();
    const second = await decoderNonRetentionSmoke();
    expect(second).toEqual(first);
    expect(first.encoderReport).toEqual(first.decoderReport);
    expect(first.encoderReport).toMatchObject({
      scopes: 1,
      projections: GENERATIONS
    });
    expect(first.encoderIdentityDigest).toBe(first.decoderIdentityDigest);
    expect(first.encoderIdentityCount).toBe(GENERATIONS);
    expect(first.decoderIdentityCount).toBe(GENERATIONS);
    expect(first.finalHead.generation).toBe(GENERATIONS);
    expect(first.retainedState).toEqual({
      producerCurrentProjections: 1,
      producerExpectedSnapshots: 1,
      encoderSinkLastIdentities: 1,
      decoderSinkLastIdentities: 1,
      maxTransportChunkBytes: MAX_TRANSPORT_CHUNK_BYTES
    });
  }, 660_000);
});
