import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { TextEncoder } from "node:util";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it, vi } from "vitest";

import type { AttuneGraphStoredProjection } from "./attunegraph-backend.js";
import {
  canonicalizeImmutableEnvelope
} from "./canonical-immutable-envelope.js";
import {
  createAttuneGraphPortableDecoder,
  AttuneGraphPortableDecoderError,
  type AttuneGraphPortableDecoderValidationSink
} from "./attunegraph-portable-decoder.js";
import {
  createAttuneGraphPortableEncoder,
  type AttuneGraphPortableEncoderIdentitySink,
  type AttuneGraphPortableProjectionIdentity,
  type AttuneGraphPortableEncoderBudgetsForInternalUse,
  type AttuneGraphPortableSummary
} from "./attunegraph-portable-encoder.js";

const RECORD_SPEC = Object.freeze({
  hashDomain: "attunegraph.portable-record.v1",
  idField: "recordId",
  idPrefix: "attunegraph-portable-record:"
} as const);
const STATE_HASH_DOMAIN = "attunegraph.portable-state.v1\0";
const PRODUCTION_BUDGETS: AttuneGraphPortableEncoderBudgetsForInternalUse = Object.freeze({
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
const caseNames = [
  "empty",
  "one-scope-two-generations",
  "unicode-multi-scope"
] as const;

interface FixtureCase {
  readonly name: (typeof caseNames)[number];
  readonly bytes: Uint8Array;
  readonly projections: readonly AttuneGraphStoredProjection[];
  readonly report: AttuneGraphPortableSummary;
}

let fixtures: readonly FixtureCase[];

beforeAll(async () => {
  const manifest = JSON.parse(
    await readFile(join(fixtureDirectory, "manifest.json"), "utf8")
  ) as {
    readonly cases: readonly {
      readonly case: (typeof caseNames)[number];
      readonly stateId: AttuneGraphPortableSummary["stateId"];
      readonly exportId: AttuneGraphPortableSummary["exportId"];
      readonly scopeCount: number;
      readonly projectionCount: number;
      readonly artifactBytes: number;
    }[];
  };
  fixtures = await Promise.all(caseNames.map(async (name) => {
    const [bytes, inputText] = await Promise.all([
      readFile(join(fixtureDirectory, `${name}.atgx`)),
      readFile(join(fixtureDirectory, `${name}.input.json`), "utf8")
    ]);
    const input = JSON.parse(inputText) as {
      readonly projections: readonly AttuneGraphStoredProjection[];
    };
    const ledger = manifest.cases.find((candidate) => candidate.case === name);
    if (ledger === undefined) throw new Error(`missing fixture ledger ${name}`);
    return {
      name,
      bytes,
      projections: input.projections,
      report: {
        format: "attunegraph-portable",
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

function validationSink(
  overrides: Partial<AttuneGraphPortableDecoderValidationSink> = {}
): {
  readonly value: AttuneGraphPortableDecoderValidationSink;
  readonly projections: AttuneGraphPortableProjectionIdentity[];
  readonly heads: AttuneGraphPortableProjectionIdentity[];
  readonly events: string[];
  readonly aborts: unknown[];
} {
  const projections: AttuneGraphPortableProjectionIdentity[] = [];
  const heads: AttuneGraphPortableProjectionIdentity[] = [];
  const events: string[] = [];
  const aborts: unknown[] = [];
  const value: AttuneGraphPortableDecoderValidationSink = {
    appendProjection(identity) {
      events.push(`projection:${identity.generation.toString()}`);
      projections.push(identity);
    },
    sealProjections() {
      events.push("seal");
    },
    assertHead(identity) {
      events.push(`head:${identity.generation.toString()}`);
      heads.push(identity);
    },
    finish(scopeCount, headCount) {
      events.push(`finish:${scopeCount.toString()}:${headCount.toString()}`);
    },
    abort(cause) {
      events.push("abort");
      aborts.push(cause);
    },
    ...overrides
  };
  return { value, projections, heads, events, aborts };
}

function irregularChunks(bytes: Uint8Array): readonly Uint8Array[] {
  const chunks: Uint8Array[] = [];
  const pattern = [1, 2, 7, 3, 16, 5, 31, 4, 64, 9];
  let offset = 0;
  let index = 0;
  while (offset < bytes.byteLength) {
    const size = pattern[index % pattern.length]!;
    const end = Math.min(bytes.byteLength, offset + size);
    chunks.push(bytes.slice(offset, end));
    offset = end;
    index += 1;
  }
  return chunks;
}

async function decode(
  bytes: Uint8Array,
  chunks: readonly Uint8Array[],
  observed = validationSink()
): Promise<{
  readonly report: AttuneGraphPortableSummary;
  readonly observed: ReturnType<typeof validationSink>;
}> {
  expect(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)).toBe(
    bytes.byteLength
  );
  const decoder = createAttuneGraphPortableDecoder(observed.value);
  for (const chunk of chunks) await decoder.write(chunk);
  return { report: await decoder.finish(), observed };
}

function encoderSink(): {
  readonly value: AttuneGraphPortableEncoderIdentitySink;
  readonly projections: AttuneGraphPortableProjectionIdentity[];
  readonly heads: AttuneGraphPortableProjectionIdentity[];
} {
  const projections: AttuneGraphPortableProjectionIdentity[] = [];
  const heads: AttuneGraphPortableProjectionIdentity[] = [];
  return {
    projections,
    heads,
    value: {
      appendProjection(identity) {
        projections.push(identity);
      },
      sealProjections() {},
      assertHead(identity) {
        heads.push(identity);
      },
      finish() {},
      abort(cause) {
        throw cause;
      }
    }
  };
}

function encodeFixture(
  projections: readonly AttuneGraphStoredProjection[]
): {
  readonly bytes: Uint8Array;
  readonly report: AttuneGraphPortableSummary;
  readonly identities: readonly AttuneGraphPortableProjectionIdentity[];
} {
  const observed = encoderSink();
  const encoder = createAttuneGraphPortableEncoder({ identitySink: observed.value });
  const chunks = [encoder.start()];
  const heads = new Map<string, AttuneGraphPortableProjectionIdentity>();
  for (const projection of projections) {
    const appended = encoder.appendProjection(
      projection.snapshot.scope,
      projection
    );
    chunks.push(appended.bytes);
    heads.set(
      JSON.stringify([
        appended.identity.scope.sourceId,
        appended.identity.scope.threadId
      ]),
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
  const output = new Uint8Array(
    chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0)
  );
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return {
    bytes: output,
    report: finished.report,
    identities: observed.projections
  };
}

function rejected(operation: () => Promise<unknown>): Promise<unknown> {
  return operation().then(
    () => {
      throw new Error("operation did not reject");
    },
    (cause: unknown) => cause
  );
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

function prefixWithRecord(
  fixture: Uint8Array,
  index: number,
  replacement: Record<string, unknown>,
  prefixRecords = index
): Uint8Array {
  const originalLines = Buffer.from(fixture).toString("utf8").split("\n");
  const chunks = [
    ...originalLines.slice(0, prefixRecords).map((line) => utf8.encode(`${line}\n`)),
    mintedLine(replacement)
  ];
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

async function decodeFailure(
  bytes: Uint8Array,
  expectedCode:
    | "INVALID_INPUT"
    | "REENTRY"
    | "LIMIT_EXCEEDED"
    | "CORRUPT_PORTABLE_EXPORT"
    | "FUTURE_PORTABLE_EXPORT"
    | "INCOMPATIBLE_PORTABLE_FORMAT",
  limits?: AttuneGraphPortableEncoderBudgetsForInternalUse,
  observed = validationSink()
): Promise<{
  readonly failure: unknown;
  readonly observed: ReturnType<typeof validationSink>;
}> {
  const decoder = createAttuneGraphPortableDecoder(observed.value, limits);
  let failure: unknown;
  try {
    await decoder.write(bytes);
  } catch (cause) {
    failure = cause;
  }
  failure ??= await rejected(() => decoder.finish());
  expect(failure).toBeInstanceOf(AttuneGraphPortableDecoderError);
  expect(failure).toMatchObject({ code: expectedCode });
  expect(await rejected(() => decoder.finish())).toBe(failure);
  return { failure, observed };
}

function exactValidationSink(): ReturnType<typeof validationSink> {
  const finalByScope = new Map<string, AttuneGraphPortableProjectionIdentity>();
  const heads = new Set<string>();
  let sealed = false;
  return validationSink({
    appendProjection(identity) {
      if (sealed) throw new Error("projection after seal");
      finalByScope.set(JSON.stringify(identity.scope), identity);
    },
    sealProjections() {
      if (sealed) throw new Error("duplicate seal");
      sealed = true;
    },
    assertHead(identity) {
      const key = JSON.stringify(identity.scope);
      expect(identity).toEqual(finalByScope.get(key));
      if (heads.has(key)) throw new Error("duplicate head");
      heads.add(key);
    },
    finish(scopeCount, headCount) {
      expect(scopeCount).toBe(finalByScope.size);
      expect(headCount).toBe(heads.size);
      expect(heads.size).toBe(finalByScope.size);
    }
  });
}

describe("package-private AttuneGraph portable decoder", () => {
  it.each(caseNames)(
    "decodes checked-in %s fixture identically as one and irregular chunks",
    async (name) => {
      const fixture = fixtures.find((candidate) => candidate.name === name)!;
      const one = await decode(fixture.bytes, [fixture.bytes]);
      const irregular = await decode(
        fixture.bytes,
        irregularChunks(fixture.bytes)
      );
      expect(one.report).toEqual(fixture.report);
      expect(irregular.report).toEqual(fixture.report);
      expect(irregular.observed.events).toEqual(one.observed.events);
      expect(irregular.observed.projections).toEqual(one.observed.projections);
      expect(irregular.observed.heads).toEqual(one.observed.heads);
      expect(Object.isFrozen(one.report)).toBe(true);
      expect(one.observed.aborts).toHaveLength(0);
    }
  );

  it.each(["empty", "one-scope-two-generations"] as const)(
    "round-trips production encoder %s output with exact report and sink stream",
    async (name) => {
      const fixture = fixtures.find((candidate) => candidate.name === name)!;
      const encoded = encodeFixture(fixture.projections);
      const decoded = await decode(encoded.bytes, irregularChunks(encoded.bytes));
      expect(decoded.report).toEqual(encoded.report);
      expect(decoded.observed.projections).toEqual(encoded.identities);
      expect(decoded.observed.heads).toEqual(
        encoded.identities.length === 0 ? [] : [encoded.identities.at(-1)]
      );
    }
  );

  it("rejects the superseded numeric format identity before validation mutation", async () => {
    const incompatibleFormat = Buffer.from(Uint8Array.of(
      109, 117, 115, 101, 45, 109, 97, 103, 45, 112, 111, 114, 116, 97, 98, 108, 101
    )).toString("utf8");
    const bytes = Buffer.from(
      Buffer.from(fixtures[0]!.bytes)
        .toString("utf8")
        .replace("attunegraph-portable", incompatibleFormat),
      "utf8"
    );
    const observed = validationSink();
    const result = await decodeFailure(
      bytes,
      "INCOMPATIBLE_PORTABLE_FORMAT",
      undefined,
      observed
    );

    expect(result.observed.projections).toEqual([]);
    expect(result.observed.heads).toEqual([]);
    expect(result.observed.events).toEqual([]);
    expect(result.observed.aborts).toHaveLength(0);
  });

  it("splits the Unicode fixture immediately around multi-byte and LF boundaries", async () => {
    const fixture = fixtures[2]!;
    const firstMultiByte = fixture.bytes.findIndex((byte) => byte >= 0x80);
    const firstLf = fixture.bytes.indexOf(0x0a);
    expect(firstMultiByte).toBeGreaterThan(0);
    expect(firstLf).toBeGreaterThan(0);
    const offsets = [...new Set([
      0,
      firstMultiByte,
      firstMultiByte + 1,
      firstLf,
      firstLf + 1,
      fixture.bytes.byteLength
    ])].sort((left, right) => left - right);
    const chunks = offsets.slice(0, -1).map(
      (offset, index) => fixture.bytes.slice(offset, offsets[index + 1])
    );
    expect((await decode(fixture.bytes, chunks)).report).toEqual(fixture.report);
  });

  it("rejects empty/truncated input and pins the original decoder failure", async () => {
    const observed = validationSink();
    const decoder = createAttuneGraphPortableDecoder(observed.value);
    const failure = await rejected(() => decoder.finish());
    expect(failure).toBeInstanceOf(AttuneGraphPortableDecoderError);
    expect(failure).toMatchObject({
      code: "CORRUPT_PORTABLE_EXPORT",
      message: "portable export is empty or truncated"
    });
    expect(observed.aborts).toHaveLength(0);
    expect(await rejected(() => decoder.write(new Uint8Array()))).toBe(failure);
    expect(await rejected(() => decoder.finish())).toBe(failure);
  });

  it("captures sink methods and detaches caller chunks at method entry", async () => {
    const fixture = fixtures[0]!;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const originalSeal = vi.fn(async () => gate);
    const observed = validationSink({ sealProjections: originalSeal });
    const decoder = createAttuneGraphPortableDecoder(observed.value);
    const chunk = Uint8Array.from(fixture.bytes);
    const pending = decoder.write(chunk);
    chunk.fill(0);
    observed.value.sealProjections = () => {
      throw new Error("replacement must not run");
    };
    release!();
    await pending;
    expect(await decoder.finish()).toEqual(fixture.report);
    expect(originalSeal).toHaveBeenCalledOnce();
  });

  it("rejects hostile sinks/chunks without observation and uses INVALID_STATE after success", async () => {
    let getterCalls = 0;
    const accessorSink =
      validationSink().value as unknown as Record<string, unknown>;
    Object.defineProperty(accessorSink, "finish", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return () => undefined;
      }
    });
    expect(() => createAttuneGraphPortableDecoder(accessorSink as never)).toThrow(
      AttuneGraphPortableDecoderError
    );
    expect(getterCalls).toBe(0);
    expect(() => createAttuneGraphPortableDecoder(
      new Proxy(validationSink().value, {})
    )).toThrow(AttuneGraphPortableDecoderError);

    class ExoticBytes extends Uint8Array {}
    const chunkCases: unknown[] = [
      new Proxy(new Uint8Array(), {}),
      new ExoticBytes(),
      new Uint16Array()
    ];
    if (typeof SharedArrayBuffer !== "undefined") {
      chunkCases.push(new Uint8Array(new SharedArrayBuffer(1)));
    }
    const transferable = new Uint8Array([1]);
    structuredClone(transferable.buffer, { transfer: [transferable.buffer] });
    chunkCases.push(transferable);
    for (const chunk of chunkCases) {
      const decoder = createAttuneGraphPortableDecoder(validationSink().value);
      const failure = await rejected(() => decoder.write(chunk as Uint8Array));
      expect(failure).toMatchObject({ code: "INVALID_INPUT" });
    }

    const fixture = fixtures[0]!;
    const decoder = createAttuneGraphPortableDecoder(validationSink().value);
    await decoder.write(fixture.bytes);
    await decoder.finish();
    await expect(decoder.write(new Uint8Array())).rejects.toMatchObject({
      code: "INVALID_STATE"
    });
    await expect(decoder.finish()).rejects.toMatchObject({
      code: "INVALID_STATE"
    });
  });

  it.each([
    ["BOM", (bytes: Uint8Array) => Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(bytes)
    ])],
    ["invalid UTF-8", (bytes: Uint8Array) => {
      const mutated = Uint8Array.from(bytes);
      mutated[0] = 0xff;
      return mutated;
    }],
    ["CRLF", (bytes: Uint8Array) => Buffer.from(
      Buffer.from(bytes).toString("utf8").replace("\n", "\r\n"),
      "utf8"
    )],
    ["blank line", (bytes: Uint8Array) => {
      const firstLf = bytes.indexOf(0x0a);
      return Buffer.concat([
        Buffer.from(bytes.slice(0, firstLf + 1)),
        Buffer.from("\n"),
        Buffer.from(bytes.slice(firstLf + 1))
      ]);
    }],
    ["missing final LF", (bytes: Uint8Array) => bytes.slice(0, -1)],
    ["extra final LF", (bytes: Uint8Array) => Buffer.concat([
      Buffer.from(bytes),
      Buffer.from("\n")
    ])],
    ["byte after footer", (bytes: Uint8Array) => Buffer.concat([
      Buffer.from(bytes),
      Buffer.from("x")
    ])]
  ] as const)(
    "rejects essential framing mutation %s",
    async (_name, mutate) => {
      await decodeFailure(
        mutate(fixtures[0]!.bytes),
        "CORRUPT_PORTABLE_EXPORT"
      );
    }
  );

  it("rejects noncanonical duplicate/reordered keys and essential semantic mutations", async () => {
    const empty = fixtures[0]!;
    const one = fixtures[1]!;
    const emptyText = Buffer.from(empty.bytes).toString("utf8");
    const duplicateKey = Buffer.from(
      emptyText.replace(
        "{\"canonicalization\":",
        "{\"format\":\"attunegraph-portable\",\"canonicalization\":"
      ),
      "utf8"
    );
    await decodeFailure(duplicateKey, "CORRUPT_PORTABLE_EXPORT");
    await decodeFailure(
      Buffer.from(
        emptyText.replace("\"formatVersion\":1", "\"formatVersion\":1.0"),
        "utf8"
      ),
      "CORRUPT_PORTABLE_EXPORT"
    );
    await decodeFailure(
      Buffer.from(
        emptyText.replace("\"sequence\":0", "\"sequence\":-0"),
        "utf8"
      ),
      "CORRUPT_PORTABLE_EXPORT"
    );
    await decodeFailure(
      Buffer.from(
        emptyText.replace("\"kind\":\"manifest\"", "\"kind\":\"\\u006danifest\""),
        "utf8"
      ),
      "CORRUPT_PORTABLE_EXPORT"
    );

    const emptyLines = emptyText.slice(0, -1).split("\n");
    const reorderedManifest = JSON.parse(emptyLines[0]!) as Record<string, unknown>;
    const reversed = Object.fromEntries(Object.entries(reorderedManifest).reverse());
    await decodeFailure(
      Buffer.from(`${JSON.stringify(reversed)}\n`, "utf8"),
      "CORRUPT_PORTABLE_EXPORT"
    );

    const oneRecords = records(one.bytes);
    const missingManifest = { ...oneRecords[0] };
    delete missingManifest.stateModel;
    await decodeFailure(
      prefixWithRecord(one.bytes, 0, missingManifest, 0),
      "CORRUPT_PORTABLE_EXPORT"
    );
    await decodeFailure(
      prefixWithRecord(one.bytes, 1, {
        ...oneRecords[1],
        sequence: 2
      }),
      "CORRUPT_PORTABLE_EXPORT"
    );
    await decodeFailure(
      prefixWithRecord(one.bytes, 2, {
        ...oneRecords[2],
        sequence: 1
      }),
      "CORRUPT_PORTABLE_EXPORT"
    );
    await decodeFailure(
      prefixWithRecord(one.bytes, 1, {
        ...oneRecords[1],
        projectionId: `attunegraph-store:${"0".repeat(64)}`
      }),
      "CORRUPT_PORTABLE_EXPORT"
    );
    await decodeFailure(
      prefixWithRecord(one.bytes, 4, {
        ...oneRecords[4],
        manifestId: `attunegraph-portable-record:${"0".repeat(64)}`
      }),
      "CORRUPT_PORTABLE_EXPORT"
    );
    await decodeFailure(
      prefixWithRecord(one.bytes, 4, {
        ...oneRecords[4],
        stateId: `attunegraph-state:${"0".repeat(64)}`
      }),
      "CORRUPT_PORTABLE_EXPORT"
    );
    for (const field of [
      "headCount",
      "scopeCount",
      "projectionCount",
      "priorRecordCount",
      "priorByteLength"
    ] as const) {
      await decodeFailure(
        prefixWithRecord(one.bytes, 4, {
          ...oneRecords[4],
          [field]: (oneRecords[4]![field] as number) + 1
        }),
        "CORRUPT_PORTABLE_EXPORT"
      );
    }
    await decodeFailure(
      prefixWithRecord(one.bytes, 0, {
        ...oneRecords[0],
        formatVersion: 2
      }, 0),
      "FUTURE_PORTABLE_EXPORT"
    );

    const regressedHead = mintedLine({
      ...oneRecords[3],
      sequence: 1
    });
    const regressedProjection = mintedLine({
      ...oneRecords[1],
      sequence: 2
    });
    await decodeFailure(
      Buffer.concat([
        Buffer.from(mintedLine(oneRecords[0]!)),
        Buffer.from(regressedHead),
        Buffer.from(regressedProjection)
      ]),
      "CORRUPT_PORTABLE_EXPORT"
    );

    const rawBadRecordId = Uint8Array.from(one.bytes);
    const recordIdOffset = Buffer.from(rawBadRecordId).indexOf(
      Buffer.from("attunegraph-portable-record:")
    ) + "attunegraph-portable-record:".length;
    rawBadRecordId[recordIdOffset] = rawBadRecordId[recordIdOffset] === 0x30
      ? 0x31
      : 0x30;
    await decodeFailure(rawBadRecordId, "CORRUPT_PORTABLE_EXPORT");
    const badExportId = Uint8Array.from(one.bytes);
    const footerStart = Buffer.from(badExportId).lastIndexOf(Buffer.from("\n")) ===
      badExportId.byteLength - 1
      ? Buffer.from(badExportId).lastIndexOf(
        Buffer.from("attunegraph-portable-record:"),
        badExportId.byteLength - 2
      )
      : -1;
    expect(footerStart).toBeGreaterThan(0);
    const exportHex = footerStart + "attunegraph-portable-record:".length;
    badExportId[exportHex] = badExportId[exportHex] === 0x30 ? 0x31 : 0x30;
    await decodeFailure(badExportId, "CORRUPT_PORTABLE_EXPORT");
  });

  it("makes equivalent corrupt chunkings fail at the same committed sink trace", async () => {
    const fixture = fixtures[1]!;
    const values = records(fixture.bytes);
    const corruptArtifact = prefixWithRecord(fixture.bytes, 2, {
      ...values[2],
      sequence: 1
    });
    const oneSink = validationSink();
    const chunkedSink = validationSink();
    const one = await decodeFailure(
      corruptArtifact,
      "CORRUPT_PORTABLE_EXPORT",
      undefined,
      oneSink
    );
    const decoder = createAttuneGraphPortableDecoder(chunkedSink.value);
    let chunkedFailure: unknown;
    for (const byte of corruptArtifact) {
      try {
        await decoder.write(Uint8Array.of(byte));
      } catch (cause) {
        chunkedFailure = cause;
        break;
      }
    }
    expect(chunkedFailure).toMatchObject({
      code: "CORRUPT_PORTABLE_EXPORT",
      message: (one.failure as Error).message
    });
    expect(chunkedSink.events).toEqual(oneSink.events);
    expect(chunkedSink.projections).toEqual(oneSink.projections);
    expect(chunkedSink.aborts).toHaveLength(oneSink.aborts.length);
  });

  it.each([
    ["projections", { maxProjections: 1 }, () => fixtures[1]!.bytes],
    ["heads", { maxHeads: 1 }, () => fixtures[2]!.bytes],
    ["scopes", { maxScopes: 1 }, () => fixtures[2]!.bytes],
    ["total records", { maxTotalRecords: 2 }, () => fixtures[1]!.bytes],
    ["portable line", { maxPortableLineBytes: 1_937 }, () => fixtures[1]!.bytes],
    ["edge line", { maxEdgeLineBytes: 350 }, () => fixtures[0]!.bytes],
    ["artifact bytes", { maxArtifactBytes: 777 }, () => fixtures[0]!.bytes]
  ] as const)(
    "fails the reduced %s limit independently",
    async (_name, override, artifact) => {
      await decodeFailure(
        artifact(),
        "LIMIT_EXCEEDED",
        { ...PRODUCTION_BUDGETS, ...override }
      );
    }
  );

  it.each([
    ["appendProjection", "sync", "one-scope-two-generations"],
    ["appendProjection", "async", "one-scope-two-generations"],
    ["sealProjections", "sync", "empty"],
    ["sealProjections", "async", "empty"],
    ["assertHead", "sync", "one-scope-two-generations"],
    ["assertHead", "async", "one-scope-two-generations"],
    ["finish", "sync", "empty"],
    ["finish", "async", "empty"]
  ] as const)(
    "pins original %s %s sink failure and aborts once",
    async (method, mode, fixtureName) => {
      const failure = new Error(`${method}-${mode}`);
      const observed = validationSink({
        [method]() {
          if (mode === "sync") throw failure;
          return Promise.reject(failure);
        },
        abort() {
          observed.aborts.push(failure);
          return Promise.reject(new Error("abort rejection"));
        }
      });
      const fixture = fixtures.find(
        (candidate) => candidate.name === fixtureName
      )!;
      const decoder = createAttuneGraphPortableDecoder(observed.value);
      const thrown = await rejected(() => decoder.write(fixture.bytes));
      expect(thrown).toBe(failure);
      expect(observed.aborts).toEqual([failure]);
      expect(await rejected(() => decoder.finish())).toBe(failure);
      expect(observed.aborts).toHaveLength(1);
    }
  );

  it.each([
    ["sync", "undefined", undefined],
    ["async", "undefined", undefined],
    ["sync", "null", null],
    ["async", "null", null]
  ] as const)(
    "pins exact nullish %s %s sink rejection without overwrite or resumed work",
    async (mode, _label, payload) => {
      const fixture = fixtures[1]!;
      let appendAttempts = 0;
      let abortCalls = 0;
      const abortValues: unknown[] = [];
      const observed = validationSink({
        appendProjection() {
          appendAttempts += 1;
          if (mode === "sync") throw payload;
          return Promise.reject(payload);
        },
        abort(cause) {
          abortCalls += 1;
          abortValues.push(cause);
        }
      });
      const decoder = createAttuneGraphPortableDecoder(observed.value);
      expect(await rejected(() => decoder.write(fixture.bytes))).toBe(payload);
      expect(appendAttempts).toBe(1);
      expect(abortCalls).toBe(1);
      expect(abortValues).toEqual([payload]);
      const eventsAtTerminal = [...observed.events];
      const projectionsAtTerminal = [...observed.projections];
      const headsAtTerminal = [...observed.heads];

      expect(await rejected(() => decoder.write(new Uint8Array()))).toBe(
        payload
      );
      expect(await rejected(() => decoder.finish())).toBe(payload);
      expect(await rejected(() => decoder.write(fixture.bytes))).toBe(payload);
      expect(appendAttempts).toBe(1);
      expect(abortCalls).toBe(1);
      expect(abortValues).toEqual([payload]);
      expect(observed.events).toEqual(eventsAtTerminal);
      expect(observed.projections).toEqual(projectionsAtTerminal);
      expect(observed.heads).toEqual(headsAtTerminal);
    }
  );

  it("makes substituted, missing, and duplicate heads RED at the exact-head sink boundary", async () => {
    const fixture = fixtures[1]!;
    const values = records(fixture.bytes);
    const lines = Buffer.from(fixture.bytes).toString("utf8").slice(0, -1).split("\n");
    const prefixThroughProjections = Buffer.from(
      `${lines.slice(0, 3).join("\n")}\n`,
      "utf8"
    );

    const substituted = Buffer.concat([
      prefixThroughProjections,
      Buffer.from(mintedLine({
        ...values[3],
        projectionId: `attunegraph-store:${"0".repeat(64)}`
      }))
    ]);
    const substitutedSink = exactValidationSink();
    const substitutedDecoder = createAttuneGraphPortableDecoder(substitutedSink.value);
    const substitutedFailure = await rejected(
      () => substitutedDecoder.write(substituted)
    );
    expect(substitutedFailure).not.toBeInstanceOf(AttuneGraphPortableDecoderError);
    expect(substitutedSink.aborts).toEqual([substitutedFailure]);

    const state = createHash("sha256")
      .update(STATE_HASH_DOMAIN, "utf8")
      .update(prefixThroughProjections)
      .digest("hex");
    const missingFooter = mintedLine({
      headCount: 0,
      kind: "footer",
      manifestId: values[0]!.recordId,
      priorByteLength: prefixThroughProjections.byteLength,
      priorRecordCount: 3,
      projectionCount: 2,
      schemaVersion: 1,
      scopeCount: 0,
      sequence: 3,
      stateId: `attunegraph-state:${state}`
    });
    const missingSink = exactValidationSink();
    const missingDecoder = createAttuneGraphPortableDecoder(missingSink.value);
    const missingFailure = await rejected(() => missingDecoder.write(
      Buffer.concat([prefixThroughProjections, Buffer.from(missingFooter)])
    ));
    expect(missingFailure).not.toBeInstanceOf(AttuneGraphPortableDecoderError);
    expect(missingSink.aborts).toEqual([missingFailure]);

    const duplicate = Buffer.concat([
      Buffer.from(`${lines.slice(0, 4).join("\n")}\n`, "utf8"),
      Buffer.from(mintedLine({
        ...values[3],
        sequence: 4
      }))
    ]);
    const duplicateResult = await decodeFailure(
      duplicate,
      "CORRUPT_PORTABLE_EXPORT",
      undefined,
      exactValidationSink()
    );
    expect(duplicateResult.observed.aborts).toEqual([
      duplicateResult.failure
    ]);
  });

  it("turns concurrent async operation reentry into the terminal failure before further sink calls", async () => {
    const fixture = fixtures[1]!;
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let appendEntered: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      appendEntered = resolve;
    });
    const observed = validationSink({
      async appendProjection(identity) {
        observed.events.push(`delayed:${identity.generation.toString()}`);
        appendEntered!();
        await gate;
      }
    });
    const decoder = createAttuneGraphPortableDecoder(observed.value);
    const inFlight = decoder.write(fixture.bytes);
    await entered;
    const reentry = await rejected(() => decoder.finish());
    expect(reentry).toMatchObject({ code: "REENTRY" });
    expect(observed.aborts).toEqual([reentry]);
    release!();
    expect(await rejected(() => inFlight)).toBe(reentry);
    expect(await rejected(() => decoder.write(new Uint8Array()))).toBe(reentry);
    expect(observed.events.filter((event) => event === "abort")).toHaveLength(1);
    expect(observed.events.some((event) => event === "seal")).toBe(false);
    expect(observed.events.some((event) => event.startsWith("head:"))).toBe(false);
    expect(observed.events.some((event) => event.startsWith("finish:"))).toBe(false);
  });

  it("keeps the decoder absent from root/local/backend/testing/package exports", async () => {
    const surfaces = await Promise.all([
      import("./index.js"),
      import("./local.js"),
      import("./attunegraph-backend.js"),
      import("./testing.js")
    ]);
    for (const surface of surfaces) {
      expect(Object.hasOwn(surface, "createAttuneGraphPortableDecoder")).toBe(false);
      expect(Object.hasOwn(surface, "AttuneGraphPortableDecoderError")).toBe(false);
    }
    const privateSubpath = "@attunegraph/core/attunegraph-portable-decoder";
    await expect(import(privateSubpath)).rejects.toThrow(/not exported/u);
  });
});
