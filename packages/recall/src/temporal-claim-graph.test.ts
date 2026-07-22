import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createNoteSpanIdentityV1,
  createSupersedesRelationV1,
  createTemporalClaimGraphV1,
  lookupTemporalClaimGraphEndpointV1,
  NoteSpanIdentityError,
  NOTES_CHUNKER_VERSION,
  NOTES_INDEX_SCHEMA_VERSION,
  resolveNoteSpanIdentityV1,
  resolveNoteSpanIdentityV1FromIndex,
  type CreateNoteSpanIdentityV1Input,
  type NoteSourceIndexChunkV1,
  type NoteSourceIndexViewV1
} from "./index.js";

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function makeSourceIndex(
  sourceBytes: Uint8Array,
  chunks: readonly NoteSourceIndexChunkV1[],
  sourcePath = "생활/거주.md"
): NoteSourceIndexViewV1 {
  return {
    chunkerVersion: NOTES_CHUNKER_VERSION,
    chunks,
    notesIndexSchema: NOTES_INDEX_SCHEMA_VERSION,
    sourceHash: sha256(sourceBytes),
    sourcePath
  };
}

function koreanSpanFixture(options: {
  readonly chunkText?: string;
  readonly chunks?: readonly NoteSourceIndexChunkV1[];
  readonly sourceText?: string;
  readonly span?: string;
} = {}) {
  const chunkText = options.chunkText ?? "현재 집은 부산이다.";
  const sourceBytes = Buffer.from(options.sourceText ?? chunkText, "utf8");
  const span = options.span ?? "부산";
  const chunkBytes = Buffer.from(chunkText, "utf8");
  const spanBytes = Buffer.from(span, "utf8");
  const start = chunkBytes.indexOf(spanBytes);
  const end = start + spanBytes.byteLength;
  const sourceIndex = makeSourceIndex(
    sourceBytes,
    options.chunks ?? [{ chunkIndex: 0, text: chunkText }]
  );
  const input: CreateNoteSpanIdentityV1Input = {
    chunkIndex: 0,
    end,
    sourceBytes,
    sourceIndex,
    start
  };
  return { chunkBytes, chunkText, end, input, sourceBytes, sourceIndex, span, spanBytes, start };
}

function createFixtureIdentity(fixture: ReturnType<typeof koreanSpanFixture>) {
  return createNoteSpanIdentityV1(fixture.input);
}

function currentFor(fixture: ReturnType<typeof koreanSpanFixture>) {
  return { sourceBytes: fixture.sourceBytes, sourceIndex: fixture.sourceIndex };
}

describe("exact temporal note spans", () => {
  it("creates and resolves a Korean span using raw UTF-8 byte offsets through the public package export", () => {
    const fixture = koreanSpanFixture({
      chunkText: "현재 집은 부산 해운대다.",
      sourceText: "# 생활\n\n현재 집은 부산 해운대다.\n",
      span: "부산 해운대"
    });

    expect(fixture.start).not.toBe(fixture.chunkText.indexOf(fixture.span));

    const identity = createFixtureIdentity(fixture);

    expect(Object.isFrozen(identity)).toBe(true);
    expect(identity).toMatchObject({
      chunkHash: sha256(fixture.chunkText),
      chunkIndex: 0,
      chunkerVersion: NOTES_CHUNKER_VERSION,
      end: fixture.end,
      notesIndexSchema: NOTES_INDEX_SCHEMA_VERSION,
      schema: "muse.note-span.v1",
      sourceHash: sha256(fixture.sourceBytes),
      sourcePath: "생활/거주.md",
      spanHash: sha256(fixture.span),
      start: fixture.start
    });
    expect(identity.sourceIndexDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(resolveNoteSpanIdentityV1(identity, currentFor(fixture))).toEqual({
      span: fixture.span,
      status: "resolved"
    });
    expect(resolveNoteSpanIdentityV1FromIndex(identity, fixture.sourceIndex)).toEqual({
      span: fixture.span,
      status: "resolved"
    });
    expect(resolveNoteSpanIdentityV1FromIndex(identity, {
      ...fixture.sourceIndex,
      sourceHash: "0".repeat(64)
    })).toEqual({ status: "inert" });
  });

  it("accepts only canonical text source paths within the 512-byte UTF-8 boundary", () => {
    const fixture = koreanSpanFixture();
    const sourcePath = `${"가".repeat(169)}aa.md`;
    const sourceIndex = makeSourceIndex(
      fixture.sourceBytes,
      fixture.sourceIndex.chunks,
      sourcePath
    );
    expect(Buffer.byteLength(sourcePath, "utf8")).toBe(512);

    const identity = createNoteSpanIdentityV1({ ...fixture.input, sourceIndex });
    expect(identity.sourcePath).toBe(sourcePath);
    expect(resolveNoteSpanIdentityV1(identity, {
      sourceBytes: fixture.sourceBytes,
      sourceIndex
    })).toEqual({ span: fixture.span, status: "resolved" });

    const invalidPaths = [
      { name: "513 UTF-8 bytes", sourcePath: `${"가".repeat(169)}aaa.md` },
      { name: "absolute POSIX", sourcePath: "/생활.md" },
      { name: "drive prefix", sourcePath: "C:생활.md" },
      { name: "backslash", sourcePath: "생활\\거주.md" },
      { name: "traversal segment", sourcePath: "생활/../거주.md" },
      { name: "dot segment", sourcePath: "생활/./거주.md" },
      { name: "empty segment", sourcePath: "생활//거주.md" },
      { name: "NUL", sourcePath: "생활/\0거주.md" },
      { name: "PDF", sourcePath: "생활/거주.pdf" }
    ] as const;

    for (const invalidPath of invalidPaths) {
      let error: unknown;
      try {
        createNoteSpanIdentityV1({
          ...fixture.input,
          sourceIndex: makeSourceIndex(
            fixture.sourceBytes,
            fixture.sourceIndex.chunks,
            invalidPath.sourcePath
          )
        });
      } catch (cause) {
        error = cause;
      }
      expect(error, invalidPath.name).toBeInstanceOf(NoteSpanIdentityError);
      expect(error, invalidPath.name).toMatchObject({
        code: "RECALL_NOTE_SPAN_INVALID",
        message: "Note span identity input is invalid.",
        name: "NoteSpanIdentityError",
        stack: "NoteSpanIdentityError: Note span identity input is invalid."
      });
    }
  });

  it("accepts only nonempty raw spans within the 4096-byte UTF-8 boundary", () => {
    const exactSpan = "a".repeat(4_096);
    const exactFixture = koreanSpanFixture({ chunkText: exactSpan, span: exactSpan });
    expect(exactFixture.spanBytes.byteLength).toBe(4_096);

    const identity = createFixtureIdentity(exactFixture);
    expect(resolveNoteSpanIdentityV1(identity, currentFor(exactFixture))).toEqual({
      span: exactSpan,
      status: "resolved"
    });

    const oversizedSpan = "a".repeat(4_097);
    const oversizedFixture = koreanSpanFixture({ chunkText: oversizedSpan, span: oversizedSpan });
    const emptyFixture = koreanSpanFixture({ chunkText: "a", span: "" });
    const splitFixture = koreanSpanFixture({ chunkText: "가", span: "가" });
    expect(oversizedFixture.spanBytes.byteLength).toBe(4_097);
    expect(emptyFixture.spanBytes.byteLength).toBe(0);
    expect(splitFixture.chunkBytes.byteLength).toBe(3);
    const invalidInputs = [
      { input: oversizedFixture.input, name: "4097 bytes" },
      { input: emptyFixture.input, name: "empty" },
      {
        input: { ...splitFixture.input, end: 2, start: 1 },
        name: "split Korean UTF-8 code point"
      }
    ] as const;

    for (const invalidInput of invalidInputs) {
      let error: unknown;
      try {
        createNoteSpanIdentityV1(invalidInput.input);
      } catch (cause) {
        error = cause;
      }
      expect(error, invalidInput.name).toBeInstanceOf(NoteSpanIdentityError);
      expect(error, invalidInput.name).toMatchObject({
        code: "RECALL_NOTE_SPAN_INVALID",
        message: "Note span identity input is invalid.",
        name: "NoteSpanIdentityError",
        stack: "NoteSpanIdentityError: Note span identity input is invalid."
      });
    }
  });

  it("accepts source bytes through exactly 4 MiB and rejects the next byte", () => {
    const maxSourceBytes = 4 * 1_024 * 1_024;
    const chunkText = "현재 집은 부산이다.";
    const chunkBytes = Buffer.from(chunkText, "utf8");
    const spanBytes = Buffer.from("부산", "utf8");
    const start = chunkBytes.indexOf(spanBytes);
    const inputFor = (sourceByteLength: number) => {
      const sourceBytes = Buffer.alloc(sourceByteLength, 0x61);
      chunkBytes.copy(sourceBytes);
      const sourceIndex = makeSourceIndex(sourceBytes, [{ chunkIndex: 0, text: chunkText }]);
      return {
        current: { sourceBytes, sourceIndex },
        input: {
          chunkIndex: 0,
          end: start + spanBytes.byteLength,
          sourceBytes,
          sourceIndex,
          start
        }
      };
    };
    const exact = inputFor(maxSourceBytes);
    const oversized = inputFor(maxSourceBytes + 1);
    expect(exact.input.sourceBytes.byteLength).toBe(maxSourceBytes);
    expect(oversized.input.sourceBytes.byteLength).toBe(maxSourceBytes + 1);
    expect(oversized.input.sourceIndex.sourceHash).toBe(sha256(oversized.input.sourceBytes));

    const identity = createNoteSpanIdentityV1(exact.input);
    expect(resolveNoteSpanIdentityV1(identity, exact.current)).toEqual({
      span: "부산",
      status: "resolved"
    });

    let error: unknown;
    try {
      createNoteSpanIdentityV1(oversized.input);
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(NoteSpanIdentityError);
    expect(error).toMatchObject({
      code: "RECALL_NOTE_SPAN_INVALID",
      message: "Note span identity input is invalid.",
      name: "NoteSpanIdentityError",
      stack: "NoteSpanIdentityError: Note span identity input is invalid."
    });
  });

  it("accepts an indexed chunk through exactly 32 KiB and rejects the next byte", () => {
    const maxChunkBytes = 32 * 1_024;
    const exactChunkText = `${"가".repeat(10_922)}aa`;
    const oversizedChunkText = `${"가".repeat(10_922)}aaa`;
    const spanBytes = Buffer.from("가", "utf8");
    const inputFor = (chunkText: string) => {
      const sourceBytes = Buffer.from(chunkText, "utf8");
      const sourceIndex = makeSourceIndex(sourceBytes, [{ chunkIndex: 0, text: chunkText }]);
      return {
        current: { sourceBytes, sourceIndex },
        input: {
          chunkIndex: 0,
          end: spanBytes.byteLength,
          sourceBytes,
          sourceIndex,
          start: 0
        }
      };
    };
    const exact = inputFor(exactChunkText);
    const oversized = inputFor(oversizedChunkText);
    expect(Buffer.byteLength(exactChunkText, "utf8")).toBe(maxChunkBytes);
    expect(Buffer.byteLength(oversizedChunkText, "utf8")).toBe(maxChunkBytes + 1);
    expect(oversized.input.sourceBytes.byteLength).toBeLessThanOrEqual(4 * 1_024 * 1_024);
    expect(oversized.input.sourceIndex.sourceHash).toBe(sha256(oversized.input.sourceBytes));

    const identity = createNoteSpanIdentityV1(exact.input);
    expect(resolveNoteSpanIdentityV1(identity, exact.current)).toEqual({
      span: "가",
      status: "resolved"
    });

    let error: unknown;
    try {
      createNoteSpanIdentityV1(oversized.input);
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(NoteSpanIdentityError);
    expect(error).toMatchObject({
      code: "RECALL_NOTE_SPAN_INVALID",
      message: "Note span identity input is invalid.",
      name: "NoteSpanIdentityError",
      stack: "NoteSpanIdentityError: Note span identity input is invalid."
    });
  });

  it("accepts cumulative indexed chunk text through exactly 8 MiB and rejects the next byte", () => {
    const maxSourceIndexUtf8Bytes = 8 * 1_024 * 1_024;
    const maxChunkText = "a".repeat(32 * 1_024);
    const exactChunks = Array.from({ length: 256 }, (_, chunkIndex) => ({
      chunkIndex,
      text: maxChunkText
    }));
    const oversizedChunks = [
      ...exactChunks,
      { chunkIndex: exactChunks.length, text: "a" }
    ];
    const sourceBytes = Buffer.from("a", "utf8");
    const inputFor = (chunks: readonly NoteSourceIndexChunkV1[]) => {
      const sourceIndex = makeSourceIndex(sourceBytes, chunks);
      return {
        current: { sourceBytes, sourceIndex },
        input: {
          chunkIndex: 0,
          end: 1,
          sourceBytes,
          sourceIndex,
          start: 0
        }
      };
    };
    const totalUtf8Bytes = (chunks: readonly NoteSourceIndexChunkV1[]) => chunks.reduce(
      (total, chunk) => total + Buffer.byteLength(chunk.text, "utf8"),
      0
    );
    const exact = inputFor(exactChunks);
    const oversized = inputFor(oversizedChunks);
    expect(exactChunks).toHaveLength(256);
    expect(oversizedChunks).toHaveLength(257);
    expect(exactChunks.every((chunk) => Buffer.byteLength(chunk.text, "utf8") <= 32 * 1_024)).toBe(true);
    expect(totalUtf8Bytes(exactChunks)).toBe(maxSourceIndexUtf8Bytes);
    expect(totalUtf8Bytes(oversizedChunks)).toBe(maxSourceIndexUtf8Bytes + 1);
    expect(oversized.input.sourceIndex.sourceHash).toBe(sha256(sourceBytes));

    const identity = createNoteSpanIdentityV1(exact.input);
    expect(resolveNoteSpanIdentityV1(identity, exact.current)).toEqual({
      span: "a",
      status: "resolved"
    });

    let error: unknown;
    try {
      createNoteSpanIdentityV1(oversized.input);
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(NoteSpanIdentityError);
    expect(error).toMatchObject({
      code: "RECALL_NOTE_SPAN_INVALID",
      message: "Note span identity input is invalid.",
      name: "NoteSpanIdentityError",
      stack: "NoteSpanIdentityError: Note span identity input is invalid."
    });
  });

  it("rejects primitive oversized path and chunk strings before UTF-8 allocation", () => {
    const sourceBytes = Uint8Array.of(0x61);
    const oversizedPath = `${"a".repeat(510)}.md`;
    const oversizedChunk = "a".repeat(32 * 1_024 + 1);
    const pathSourceIndex = makeSourceIndex(
      sourceBytes,
      [{ chunkIndex: 0, text: "a" }],
      oversizedPath
    );
    const chunkSourceIndex = makeSourceIndex(
      sourceBytes,
      [{ chunkIndex: 0, text: oversizedChunk }]
    );
    const captureError = (sourceIndex: NoteSourceIndexViewV1): unknown => {
      try {
        createNoteSpanIdentityV1({
          chunkIndex: 0,
          end: 1,
          sourceBytes,
          sourceIndex,
          start: 0
        });
      } catch (cause) {
        return cause;
      }
      return undefined;
    };
    const fromSpy = vi.spyOn(Buffer, "from");
    let pathError: unknown;
    let chunkError: unknown;
    let oversizedPathCalls = 0;
    let oversizedChunkCalls = 0;
    try {
      pathError = captureError(pathSourceIndex);
      chunkError = captureError(chunkSourceIndex);
      for (const call of fromSpy.mock.calls) {
        if (call[0] === oversizedPath) oversizedPathCalls += 1;
        if (call[0] === oversizedChunk) oversizedChunkCalls += 1;
      }
    } finally {
      fromSpy.mockRestore();
    }

    expect(oversizedPath).toHaveLength(513);
    expect(oversizedChunk).toHaveLength(32 * 1_024 + 1);
    expect({ oversizedChunkCalls, oversizedPathCalls }).toEqual({
      oversizedChunkCalls: 0,
      oversizedPathCalls: 0
    });
    for (const error of [pathError, chunkError]) {
      expect(error).toBeInstanceOf(NoteSpanIdentityError);
      expect(error).toMatchObject({
        code: "RECALL_NOTE_SPAN_INVALID",
        message: "Note span identity input is invalid.",
        name: "NoteSpanIdentityError",
        stack: "NoteSpanIdentityError: Note span identity input is invalid."
      });
    }
  });

  it("resolves an identity clone with an extra enumerable data property as inert", () => {
    const fixture = koreanSpanFixture();
    const identity = createFixtureIdentity(fixture);
    const identityWithExtraProperty = Object.freeze({ ...identity, unexpected: "ignored today" });

    expect(resolveNoteSpanIdentityV1(identityWithExtraProperty, currentFor(fixture))).toEqual({ status: "inert" });
  });

  it("resolves an identity-shaped object with an expected enumerable getter as inert without invoking it", () => {
    const fixture = koreanSpanFixture();
    const identity = createFixtureIdentity(fixture);
    let getterReads = 0;
    const identityWithGetter = { ...identity };
    Object.defineProperty(identityWithGetter, "chunkHash", {
      enumerable: true,
      get: () => {
        getterReads += 1;
        return identity.chunkHash;
      }
    });

    const resolution = resolveNoteSpanIdentityV1(identityWithGetter, currentFor(fixture));

    expect(getterReads).toBe(0);
    expect(resolution).toEqual({ status: "inert" });
  });

  it("rejects a source-index-shaped object with an expected enumerable getter without invoking it", () => {
    const fixture = koreanSpanFixture();
    let getterReads = 0;
    Object.defineProperty(fixture.sourceIndex, "sourcePath", {
      enumerable: true,
      get: () => {
        getterReads += 1;
        return "생활/거주.md";
      }
    });
    let rejected = false;

    try {
      createNoteSpanIdentityV1(fixture.input);
    } catch {
      rejected = true;
    }

    expect(getterReads).toBe(0);
    expect(rejected).toBe(true);
  });

  it("rejects an indexed chunk with an enumerable text getter without invoking it", () => {
    const fixture = koreanSpanFixture();
    let getterReads = 0;
    const chunk = { ...fixture.sourceIndex.chunks[0]! };
    Object.defineProperty(chunk, "text", {
      enumerable: true,
      get: () => {
        getterReads += 1;
        return fixture.chunkText;
      }
    });
    const sourceIndex = makeSourceIndex(fixture.sourceBytes, [chunk]);
    let rejected = false;

    try {
      createNoteSpanIdentityV1({ ...fixture.input, sourceIndex });
    } catch {
      rejected = true;
    }

    expect(getterReads).toBe(0);
    expect(rejected).toBe(true);
  });

  it("rejects a create input with an enumerable start getter without invoking it", () => {
    const fixture = koreanSpanFixture();
    let getterReads = 0;
    const input = { ...fixture.input };
    Object.defineProperty(input, "start", {
      enumerable: true,
      get: () => {
        getterReads += 1;
        return fixture.start;
      }
    });
    let rejected = false;

    try {
      createNoteSpanIdentityV1(input);
    } catch {
      rejected = true;
    }

    expect(getterReads).toBe(0);
    expect(rejected).toBe(true);
  });

  it("closes a hostile create-input proxy error behind one fixed public recall error", () => {
    const hostileInput = new Proxy({} as Parameters<typeof createNoteSpanIdentityV1>[0], {
      ownKeys: () => {
        throw Object.assign(new Error("RAW_SECRET"), { code: "FORGED_SECRET_CODE" });
      }
    });
    let caught: unknown;

    try {
      createNoteSpanIdentityV1(hostileInput);
    } catch (error) {
      caught = error;
    }

    expect((caught as Error).message).not.toContain("RAW_SECRET");
    expect(caught).toBeInstanceOf(NoteSpanIdentityError);
    expect(caught).toMatchObject({
      code: "RECALL_NOTE_SPAN_INVALID",
      message: "Note span identity input is invalid.",
      name: "NoteSpanIdentityError"
    });
    expect((caught as Error).stack).toBe("NoteSpanIdentityError: Note span identity input is invalid.");
    expect(JSON.stringify(caught)).not.toContain("RAW_SECRET");
    expect(String(caught)).not.toContain("RAW_SECRET");
  });

  it("rejects a source-index proxy before it can mutate the bytes being attested", () => {
    const sourceBytes = Uint8Array.of(0x61);
    const mutatedBytes = Uint8Array.of(0xff);
    let trapCalls = 0;
    const sourceIndex = new Proxy(
      makeSourceIndex(mutatedBytes, [{ chunkIndex: 0, text: "a" }]),
      {
        ownKeys(target) {
          trapCalls += 1;
          sourceBytes[0] = 0xff;
          return Reflect.ownKeys(target);
        }
      }
    );
    let error: unknown;

    try {
      createNoteSpanIdentityV1({
        chunkIndex: 0,
        end: 1,
        sourceBytes,
        sourceIndex,
        start: 0
      });
    } catch (cause) {
      error = cause;
    }

    expect({
      errorName: error instanceof Error ? error.name : undefined,
      sourceByte: sourceBytes[0],
      trapCalls
    }).toEqual({
      errorName: "NoteSpanIdentityError",
      sourceByte: 0x61,
      trapCalls: 0
    });
    expect(error).toMatchObject({
      code: "RECALL_NOTE_SPAN_INVALID",
      message: "Note span identity input is invalid.",
      name: "NoteSpanIdentityError",
      stack: "NoteSpanIdentityError: Note span identity input is invalid."
    });
  });

  it("rejects proxied source bytes without invoking typed-array traps", () => {
    const target = Uint8Array.of(0x61);
    let getCalls = 0;
    let getPrototypeOfCalls = 0;
    const sourceBytes = new Proxy(target, {
      get(proxyTarget, property, receiver) {
        getCalls += 1;
        return Reflect.get(proxyTarget, property, receiver);
      },
      getPrototypeOf(proxyTarget) {
        getPrototypeOfCalls += 1;
        return Reflect.getPrototypeOf(proxyTarget);
      }
    });
    const sourceIndex = makeSourceIndex(target, [{ chunkIndex: 0, text: "a" }]);
    let error: unknown;

    try {
      createNoteSpanIdentityV1({
        chunkIndex: 0,
        end: 1,
        sourceBytes,
        sourceIndex,
        start: 0
      });
    } catch (cause) {
      error = cause;
    }

    expect({
      errorName: error instanceof Error ? error.name : undefined,
      getCalls,
      getPrototypeOfCalls
    }).toEqual({
      errorName: "NoteSpanIdentityError",
      getCalls: 0,
      getPrototypeOfCalls: 0
    });
    expect(error).toMatchObject({
      code: "RECALL_NOTE_SPAN_INVALID",
      message: "Note span identity input is invalid.",
      name: "NoteSpanIdentityError",
      stack: "NoteSpanIdentityError: Note span identity input is invalid."
    });
  });

  it("uses the intrinsic typed-array length without invoking an own byteLength getter", () => {
    const sourceBytes = Uint8Array.of(0x61);
    const sourceIndex = makeSourceIndex(sourceBytes, [{ chunkIndex: 0, text: "a" }]);
    let getterReads = 0;
    Object.defineProperty(sourceBytes, "byteLength", {
      configurable: true,
      get() {
        getterReads += 1;
        return 4 * 1_024 * 1_024 + 1;
      }
    });
    let error: unknown;
    let resolution: ReturnType<typeof resolveNoteSpanIdentityV1> | undefined;

    try {
      const identity = createNoteSpanIdentityV1({
        chunkIndex: 0,
        end: 1,
        sourceBytes,
        sourceIndex,
        start: 0
      });
      resolution = resolveNoteSpanIdentityV1(identity, { sourceBytes, sourceIndex });
    } catch (cause) {
      error = cause;
    }

    expect({
      errorName: error instanceof Error ? error.name : undefined,
      getterReads,
      resolution
    }).toEqual({
      errorName: undefined,
      getterReads: 0,
      resolution: { span: "a", status: "resolved" }
    });
  });

  it("rejects proxied canonical arrays without invoking chunk or relation traps", () => {
    const sourceBytes = Uint8Array.of(0x61);
    let chunkTrapCalls = 0;
    const chunks = new Proxy([{ chunkIndex: 0, text: "a" }], {
      getOwnPropertyDescriptor(target, property) {
        chunkTrapCalls += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
      ownKeys(target) {
        chunkTrapCalls += 1;
        return Reflect.ownKeys(target);
      }
    });
    const sourceIndex = makeSourceIndex(sourceBytes, chunks);
    let chunkError: unknown;
    try {
      createNoteSpanIdentityV1({
        chunkIndex: 0,
        end: 1,
        sourceBytes,
        sourceIndex,
        start: 0
      });
    } catch (cause) {
      chunkError = cause;
    }

    const currentFixture = koreanSpanFixture({
      chunkText: "현재 집은 부산이다.",
      span: "현재 집은 부산이다."
    });
    const staleFixture = koreanSpanFixture({
      chunkText: "예전에 집은 서울이었다.",
      span: "예전에 집은 서울이었다."
    });
    const relation = createSupersedesRelationV1({
      authoredAt: "2026-07-21T00:00:00.000Z",
      current: { context: currentFor(currentFixture), identity: createFixtureIdentity(currentFixture) },
      edgeId: "0123456789abcdef0123456789abcdef",
      stale: { context: currentFor(staleFixture), identity: createFixtureIdentity(staleFixture) }
    });
    let relationTrapCalls = 0;
    const relations = new Proxy([relation], {
      getOwnPropertyDescriptor(target, property) {
        relationTrapCalls += 1;
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
      ownKeys(target) {
        relationTrapCalls += 1;
        return Reflect.ownKeys(target);
      }
    });
    let relationError: unknown;
    try {
      createTemporalClaimGraphV1({ relations });
    } catch (cause) {
      relationError = cause;
    }

    expect({
      chunkErrorName: chunkError instanceof Error ? chunkError.name : undefined,
      chunkTrapCalls,
      relationErrorName: relationError instanceof Error ? relationError.name : undefined,
      relationTrapCalls
    }).toEqual({
      chunkErrorName: "NoteSpanIdentityError",
      chunkTrapCalls: 0,
      relationErrorName: "NoteSpanIdentityError",
      relationTrapCalls: 0
    });
    for (const error of [chunkError, relationError]) {
      expect(error).toMatchObject({
        code: "RECALL_NOTE_SPAN_INVALID",
        message: "Note span identity input is invalid.",
        name: "NoteSpanIdentityError",
        stack: "NoteSpanIdentityError: Note span identity input is invalid."
      });
    }
  });

  it("resolves a current context with an enumerable sourceBytes getter as inert without invoking it", () => {
    const fixture = koreanSpanFixture();
    const identity = createFixtureIdentity(fixture);
    let getterReads = 0;
    const current = { sourceBytes: fixture.sourceBytes, sourceIndex: fixture.sourceIndex };
    Object.defineProperty(current, "sourceBytes", {
      enumerable: true,
      get: () => {
        getterReads += 1;
        return fixture.sourceBytes;
      }
    });

    const resolution = resolveNoteSpanIdentityV1(identity, current);

    expect(getterReads).toBe(0);
    expect(resolution).toEqual({ status: "inert" });
  });

  it("rejects a chunks array with an own iterator getter without invoking it", () => {
    const fixture = koreanSpanFixture();
    let getterReads = 0;
    const chunks = [{ ...fixture.sourceIndex.chunks[0]! }];
    Object.defineProperty(chunks, Symbol.iterator, {
      enumerable: true,
      get: () => {
        getterReads += 1;
        return Array.prototype[Symbol.iterator].bind(chunks);
      }
    });
    const sourceIndex = makeSourceIndex(fixture.sourceBytes, chunks);
    let caught: unknown;

    try {
      createNoteSpanIdentityV1({ ...fixture.input, sourceIndex });
    } catch (error) {
      caught = error;
    }

    expect(getterReads).toBe(0);
    expect(caught).toBeInstanceOf(NoteSpanIdentityError);
  });

  it("rejects oversized source-index chunks before enumerating proxy keys", () => {
    const sourceBytes = Buffer.from("a", "utf8");
    let ownKeysCalls = 0;
    const chunks = new Proxy(
      Array.from({ length: 4_097 }, (_, chunkIndex) => ({ chunkIndex, text: "a" })),
      {
        ownKeys(target) {
          ownKeysCalls += 1;
          return Reflect.ownKeys(target);
        }
      }
    );
    const sourceIndex = makeSourceIndex(sourceBytes, chunks);
    let error: unknown;

    try {
      createNoteSpanIdentityV1({
        chunkIndex: 0,
        end: 1,
        sourceBytes,
        sourceIndex,
        start: 0
      });
    } catch (cause) {
      error = cause;
    }

    expect(ownKeysCalls).toBe(0);
    expect(error).toBeInstanceOf(NoteSpanIdentityError);
    expect(error).toMatchObject({
      code: "RECALL_NOTE_SPAN_INVALID",
      message: "Note span identity input is invalid.",
      name: "NoteSpanIdentityError",
      stack: "NoteSpanIdentityError: Note span identity input is invalid."
    });
  });

  it("rejects a plain canonical source-index array above the 4096-chunk cap", () => {
    const sourceBytes = Buffer.from("a", "utf8");
    const chunks = Array.from(
      { length: 4_097 },
      (_, chunkIndex) => ({ chunkIndex, text: "a" })
    );
    const sourceIndex = makeSourceIndex(sourceBytes, chunks);

    expect(() => createNoteSpanIdentityV1({
      chunkIndex: 0,
      end: 1,
      sourceBytes,
      sourceIndex,
      start: 0
    })).toThrow(NoteSpanIdentityError);
  });

  it("any bound provenance drift resolves inert", () => {
    const selectedText = "현재 집은 부산이다.";
    const unrelatedText = "회의는 수요일이다.";
    const fixture = koreanSpanFixture({
      chunkText: selectedText,
      chunks: [
        { chunkIndex: 0, text: selectedText },
        { chunkIndex: 1, text: unrelatedText }
      ],
      sourceText: `${selectedText}\n\n${unrelatedText}`
    });
    const identity = createFixtureIdentity(fixture);
    const current = currentFor(fixture);
    const differentHash = (hash: string): string => `${hash.startsWith("0") ? "1" : "0"}${hash.slice(1)}`;
    const variants = [
      {
        current: {
          sourceBytes: Buffer.from("현재 집은 서울이다.\n\n회의는 수요일이다.", "utf8"),
          sourceIndex: fixture.sourceIndex
        },
        identity,
        name: "source bytes only"
      },
      {
        current: {
          sourceBytes: fixture.sourceBytes,
          sourceIndex: {
            ...fixture.sourceIndex,
            chunks: [{ chunkIndex: 0, text: "현재 집은 서울이다." }, fixture.sourceIndex.chunks[1]!]
          }
        },
        identity,
        name: "selected chunk text"
      },
      {
        current: {
          sourceBytes: fixture.sourceBytes,
          sourceIndex: {
            ...fixture.sourceIndex,
            chunks: [fixture.sourceIndex.chunks[0]!, { chunkIndex: 1, text: "회의는 목요일이다." }]
          }
        },
        identity,
        name: "unrelated ordered chunk"
      },
      {
        current: {
          sourceBytes: fixture.sourceBytes,
          sourceIndex: { ...fixture.sourceIndex, sourcePath: "생활/이전-거주.md" }
        },
        identity,
        name: "source path"
      },
      {
        current: {
          sourceBytes: fixture.sourceBytes,
          sourceIndex: {
            ...fixture.sourceIndex,
            notesIndexSchema: (NOTES_INDEX_SCHEMA_VERSION + 1) as typeof NOTES_INDEX_SCHEMA_VERSION
          }
        },
        identity,
        name: "notes-index schema"
      },
      {
        current: {
          sourceBytes: fixture.sourceBytes,
          sourceIndex: {
            ...fixture.sourceIndex,
            chunkerVersion: "muse.notes.chunk-text.v2" as typeof NOTES_CHUNKER_VERSION
          }
        },
        identity,
        name: "chunker version"
      },
      {
        current,
        identity: { ...identity, sourceHash: differentHash(identity.sourceHash) },
        name: "stored source hash"
      },
      {
        current,
        identity: { ...identity, sourceIndexDigest: differentHash(identity.sourceIndexDigest) },
        name: "stored source-index digest"
      },
      {
        current,
        identity: { ...identity, chunkHash: differentHash(identity.chunkHash) },
        name: "stored chunk hash"
      },
      {
        current,
        identity: { ...identity, spanHash: differentHash(identity.spanHash) },
        name: "stored span hash"
      },
      {
        current,
        identity: { ...identity, start: 0 },
        name: "stored start offset"
      },
      {
        current,
        identity: { ...identity, end: fixture.chunkBytes.byteLength },
        name: "stored end offset"
      }
    ] as const;

    for (const variant of variants) {
      expect(resolveNoteSpanIdentityV1(variant.identity, variant.current), variant.name).toEqual({ status: "inert" });
    }
  });

  it("requires the source-index view to carry the matching index-time source hash", () => {
    const fixture = koreanSpanFixture();
    const identity = createFixtureIdentity(fixture);

    expect(resolveNoteSpanIdentityV1(identity, currentFor(fixture))).toEqual({
      span: fixture.span,
      status: "resolved"
    });
    expect(() => createNoteSpanIdentityV1({
      ...fixture.input,
      sourceIndex: {
        ...fixture.sourceIndex,
        sourceHash: `${fixture.sourceIndex.sourceHash.startsWith("0") ? "1" : "0"}${fixture.sourceIndex.sourceHash.slice(1)}`
      }
    })).toThrow(NoteSpanIdentityError);
  });

  it("creates a frozen exact supersedes relation only in the user-authored stale-marker direction", () => {
    const currentFixture = koreanSpanFixture({
      chunkText: "현재 집은 부산이다.",
      span: "현재 집은 부산이다."
    });
    const staleFixture = koreanSpanFixture({
      chunkText: "예전에 집은 서울이었다.",
      span: "예전에 집은 서울이었다."
    });
    const currentEndpoint = {
      context: currentFor(currentFixture),
      identity: createFixtureIdentity(currentFixture)
    };
    const staleEndpoint = {
      context: currentFor(staleFixture),
      identity: createFixtureIdentity(staleFixture)
    };
    const input = {
      authoredAt: "2026-07-21T00:00:00.000Z",
      current: currentEndpoint,
      edgeId: "0123456789abcdef0123456789abcdef",
      stale: staleEndpoint
    } as const;

    const relation = createSupersedesRelationV1(input);

    expect(relation).toEqual({
      authoredAt: input.authoredAt,
      current: currentEndpoint.identity,
      edgeId: input.edgeId,
      schema: "muse.note-relation.supersedes.v1",
      stale: staleEndpoint.identity
    });
    expect(Object.isFrozen(relation)).toBe(true);
    expect(Object.isFrozen(relation.current)).toBe(true);
    expect(Object.isFrozen(relation.stale)).toBe(true);
    expect(relation.current).not.toBe(currentEndpoint.identity);
    expect(relation.stale).not.toBe(staleEndpoint.identity);
    expect(JSON.stringify(relation)).not.toContain(currentFixture.span);
    expect(JSON.stringify(relation)).not.toContain(staleFixture.span);

    expect(() => createSupersedesRelationV1({
      ...input,
      current: staleEndpoint,
      stale: currentEndpoint
    })).toThrow(NoteSpanIdentityError);
  });

  it("rejects relation self-edges and duplicate graph edge IDs with the fixed public error", () => {
    const endpointFor = (text: string) => {
      const fixture = koreanSpanFixture({ chunkText: text, span: text });
      return { context: currentFor(fixture), identity: createFixtureIdentity(fixture) };
    };
    const currentA = endpointFor("현재 집은 부산이다.");
    const staleA = endpointFor("예전에 집은 서울이었다.");
    const currentB = endpointFor("현재 사무실은 강남이다.");
    const staleB = endpointFor("예전에 사무실은 종로였다.");
    const edgeId = "0123456789abcdef0123456789abcdef";
    const captureError = (operation: () => unknown): unknown => {
      try {
        operation();
      } catch (cause) {
        return cause;
      }
      return undefined;
    };
    const expectedError = {
      code: "RECALL_NOTE_SPAN_INVALID",
      message: "Note span identity input is invalid.",
      name: "NoteSpanIdentityError",
      stack: "NoteSpanIdentityError: Note span identity input is invalid."
    } as const;

    const selfEdgeError = captureError(() => createSupersedesRelationV1({
      authoredAt: "2026-07-21T00:00:00.000Z",
      current: currentA,
      edgeId,
      stale: currentA
    }));
    expect(selfEdgeError).toBeInstanceOf(NoteSpanIdentityError);
    expect(selfEdgeError).toMatchObject(expectedError);

    const first = createSupersedesRelationV1({
      authoredAt: "2026-07-21T00:00:00.000Z",
      current: currentA,
      edgeId,
      stale: staleA
    });
    const second = createSupersedesRelationV1({
      authoredAt: "2026-07-21T00:00:00.000Z",
      current: currentB,
      edgeId,
      stale: staleB
    });
    expect(new Set([
      JSON.stringify(first.current),
      JSON.stringify(first.stale),
      JSON.stringify(second.current),
      JSON.stringify(second.stale)
    ]).size).toBe(4);

    const duplicateEdgeIdError = captureError(() => createTemporalClaimGraphV1({
      relations: [first, second]
    }));
    expect(duplicateEdgeIdError).toBeInstanceOf(NoteSpanIdentityError);
    expect(duplicateEdgeIdError).toMatchObject(expectedError);
  });

  it("blocks mixed-role endpoint reuse before a chain or cycle can receive a relation brand", () => {
    const endpointFor = (text: string) => {
      const fixture = koreanSpanFixture({ chunkText: text, span: text });
      return { context: currentFor(fixture), identity: createFixtureIdentity(fixture) };
    };
    const current = endpointFor("현재 집은 부산이다.");
    const stale = endpointFor("예전에 집은 서울이었다.");
    const otherCurrent = endpointFor("현재 사무실은 강남이다.");
    const otherStale = endpointFor("예전에 사무실은 종로였다.");
    const relation = createSupersedesRelationV1({
      authoredAt: "2026-07-21T00:00:00.000Z",
      current,
      edgeId: "11111111111111111111111111111111",
      stale
    });
    expect(createTemporalClaimGraphV1({ relations: [relation] }).relations).toEqual([relation]);
    const captureError = (operation: () => unknown): unknown => {
      try {
        operation();
      } catch (cause) {
        return cause;
      }
      return undefined;
    };

    const staleReusedAsCurrent = captureError(() => createSupersedesRelationV1({
      authoredAt: "2026-07-21T00:00:01.000Z",
      current: stale,
      edgeId: "22222222222222222222222222222222",
      stale: otherStale
    }));
    const currentReusedAsStale = captureError(() => createSupersedesRelationV1({
      authoredAt: "2026-07-21T00:00:02.000Z",
      current: otherCurrent,
      edgeId: "33333333333333333333333333333333",
      stale: current
    }));

    for (const error of [staleReusedAsCurrent, currentReusedAsStale]) {
      expect(error).toBeInstanceOf(NoteSpanIdentityError);
      expect(error).toMatchObject({
        code: "RECALL_NOTE_SPAN_INVALID",
        message: "Note span identity input is invalid.",
        name: "NoteSpanIdentityError",
        stack: "NoteSpanIdentityError: Note span identity input is invalid."
      });
    }
  });

  it("creates an order-invariant deeply frozen graph only from authentic supersedes relations", () => {
    const relationFor = (
      edgeId: string,
      currentText: string,
      staleText: string,
      authoredAt: string
    ) => {
      const currentFixture = koreanSpanFixture({ chunkText: currentText, span: currentText });
      const staleFixture = koreanSpanFixture({ chunkText: staleText, span: staleText });
      return {
        currentText,
        relation: createSupersedesRelationV1({
          authoredAt,
          current: { context: currentFor(currentFixture), identity: createFixtureIdentity(currentFixture) },
          edgeId,
          stale: { context: currentFor(staleFixture), identity: createFixtureIdentity(staleFixture) }
        }),
        staleText
      };
    };
    const later = relationFor(
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "현재 사무실은 강남이다.",
      "예전에 사무실은 종로였다.",
      "2026-07-21T01:00:00.000Z"
    );
    const earlier = relationFor(
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "현재 집은 부산이다.",
      "예전에 집은 서울이었다.",
      "2026-07-21T00:00:00.000Z"
    );

    const graph = createTemporalClaimGraphV1({ relations: [later.relation, earlier.relation] });
    const reordered = createTemporalClaimGraphV1({ relations: [earlier.relation, later.relation] });

    expect(graph.schema).toBe("muse.temporal-claim-graph.v1");
    expect(graph.relations).toEqual([earlier.relation, later.relation]);
    expect(graph.relations).toHaveLength(2);
    expect(graph.semanticDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(reordered.semanticDigest).toBe(graph.semanticDigest);
    expect(reordered.relations).toEqual(graph.relations);
    expect(Object.isFrozen(graph)).toBe(true);
    expect(Object.isFrozen(graph.relations)).toBe(true);
    for (const relation of graph.relations) {
      expect(Object.isFrozen(relation)).toBe(true);
      expect(Object.isFrozen(relation.current)).toBe(true);
      expect(Object.isFrozen(relation.stale)).toBe(true);
    }
    const serialized = JSON.stringify(graph);
    expect(serialized).not.toContain("context");
    expect(serialized).not.toContain("sourceBytes");
    for (const text of [earlier.currentText, earlier.staleText, later.currentText, later.staleText]) {
      expect(serialized).not.toContain(text);
    }

    const unbrandedClone = JSON.parse(JSON.stringify(earlier.relation)) as typeof earlier.relation;
    expect(() => createTemporalClaimGraphV1({ relations: [unbrandedClone] })).toThrow(NoteSpanIdentityError);
  });

  it("accepts exactly 1024 relations and rejects a plain canonical 1025th", () => {
    const relationAt = (index: number) => {
      const currentText = `현재 항목 ${index.toString()}은 유효하다.`;
      const staleText = `예전에 항목 ${index.toString()}은 이전 값이었다.`;
      const currentFixture = koreanSpanFixture({ chunkText: currentText, span: currentText });
      const staleFixture = koreanSpanFixture({ chunkText: staleText, span: staleText });
      return createSupersedesRelationV1({
        authoredAt: "2026-07-21T00:00:00.000Z",
        current: { context: currentFor(currentFixture), identity: createFixtureIdentity(currentFixture) },
        edgeId: index.toString(16).padStart(32, "0"),
        stale: { context: currentFor(staleFixture), identity: createFixtureIdentity(staleFixture) }
      });
    };
    const relations = Array.from({ length: 1_024 }, (_, index) => relationAt(index));
    expect(new Set(relations.map((relation) => relation.edgeId)).size).toBe(1_024);
    expect(relations.every((relation) => /^[0-9a-f]{32}$/u.test(relation.edgeId))).toBe(true);
    expect(new Set(relations.flatMap((relation) => [
      JSON.stringify(relation.current),
      JSON.stringify(relation.stale)
    ])).size).toBe(2_048);

    const graph = createTemporalClaimGraphV1({ relations: [...relations].reverse() });

    expect(graph.relations).toHaveLength(1_024);
    expect(graph.relations.map((relation) => relation.edgeId)).toEqual(
      relations.map((relation) => relation.edgeId)
    );
    expect(graph.relations[0]).toBe(relations[0]);
    expect(graph.relations.at(-1)).toBe(relations.at(-1));
    expect(Object.isFrozen(graph)).toBe(true);
    expect(Object.isFrozen(graph.relations)).toBe(true);
    expect(() => createTemporalClaimGraphV1({
      relations: [...relations, relationAt(1_024)]
    })).toThrow(NoteSpanIdentityError);
  });

  it("changes the semantic digest for each authored or endpoint provenance change", () => {
    const currentFixture = koreanSpanFixture({
      chunkText: "현재 집은 부산 해운대다.",
      span: "부산"
    });
    const staleFixture = koreanSpanFixture({
      chunkText: "예전에 집은 서울이었다.",
      span: "예전에 집은 서울이었다."
    });
    const current = {
      context: currentFor(currentFixture),
      identity: createFixtureIdentity(currentFixture)
    };
    const stale = {
      context: currentFor(staleFixture),
      identity: createFixtureIdentity(staleFixture)
    };
    const alternateSpanBytes = Buffer.from("해운대", "utf8");
    const alternateSpanStart = currentFixture.chunkBytes.indexOf(alternateSpanBytes);
    const alternateSpanCurrent = {
      context: currentFor(currentFixture),
      identity: createNoteSpanIdentityV1({
        ...currentFixture.input,
        end: alternateSpanStart + alternateSpanBytes.byteLength,
        start: alternateSpanStart
      })
    };
    const alternatePathSourceIndex = makeSourceIndex(
      currentFixture.sourceBytes,
      currentFixture.sourceIndex.chunks,
      "생활/다른-거주.md"
    );
    const alternatePathCurrent = {
      context: {
        sourceBytes: currentFixture.sourceBytes,
        sourceIndex: alternatePathSourceIndex
      },
      identity: createNoteSpanIdentityV1({
        ...currentFixture.input,
        sourceIndex: alternatePathSourceIndex
      })
    };
    const baseAuthoredAt = "2026-07-21T00:00:00.000Z";
    const baseEdgeId = "0123456789abcdef0123456789abcdef";
    const graphFor = (options: {
      readonly authoredAt?: string;
      readonly current?: typeof current;
      readonly edgeId?: string;
    } = {}) => createTemporalClaimGraphV1({
      relations: [createSupersedesRelationV1({
        authoredAt: options.authoredAt ?? baseAuthoredAt,
        current: options.current ?? current,
        edgeId: options.edgeId ?? baseEdgeId,
        stale
      })]
    });

    const base = graphFor();
    const authoredAt = graphFor({ authoredAt: "2026-07-21T00:00:01.000Z" });
    const edgeId = graphFor({ edgeId: "fedcba9876543210fedcba9876543210" });
    const selectedSpan = graphFor({ current: alternateSpanCurrent });
    const sourcePath = graphFor({ current: alternatePathCurrent });
    const baseRelation = base.relations[0]!;
    const authoredAtRelation = authoredAt.relations[0]!;
    const edgeIdRelation = edgeId.relations[0]!;
    const selectedSpanIdentity = selectedSpan.relations[0]!.current;
    const sourcePathIdentity = sourcePath.relations[0]!.current;

    expect(authoredAtRelation.authoredAt).not.toBe(baseRelation.authoredAt);
    expect(authoredAtRelation.edgeId).toBe(baseRelation.edgeId);
    expect(authoredAtRelation.current).toEqual(baseRelation.current);
    expect(authoredAtRelation.stale).toEqual(baseRelation.stale);
    expect(edgeIdRelation.edgeId).not.toBe(baseRelation.edgeId);
    expect(edgeIdRelation.authoredAt).toBe(baseRelation.authoredAt);
    expect(edgeIdRelation.current).toEqual(baseRelation.current);
    expect(edgeIdRelation.stale).toEqual(baseRelation.stale);
    expect(selectedSpanIdentity).toMatchObject({
      chunkHash: baseRelation.current.chunkHash,
      chunkIndex: baseRelation.current.chunkIndex,
      chunkerVersion: baseRelation.current.chunkerVersion,
      notesIndexSchema: baseRelation.current.notesIndexSchema,
      schema: baseRelation.current.schema,
      sourceHash: baseRelation.current.sourceHash,
      sourceIndexDigest: baseRelation.current.sourceIndexDigest,
      sourcePath: baseRelation.current.sourcePath
    });
    expect(selectedSpanIdentity.start).not.toBe(baseRelation.current.start);
    expect(selectedSpanIdentity.end).not.toBe(baseRelation.current.end);
    expect(selectedSpanIdentity.spanHash).not.toBe(baseRelation.current.spanHash);
    expect(sourcePathIdentity).toMatchObject({
      chunkHash: baseRelation.current.chunkHash,
      chunkIndex: baseRelation.current.chunkIndex,
      chunkerVersion: baseRelation.current.chunkerVersion,
      end: baseRelation.current.end,
      notesIndexSchema: baseRelation.current.notesIndexSchema,
      schema: baseRelation.current.schema,
      sourceHash: baseRelation.current.sourceHash,
      spanHash: baseRelation.current.spanHash,
      start: baseRelation.current.start
    });
    expect(sourcePathIdentity.sourcePath).not.toBe(baseRelation.current.sourcePath);
    expect(sourcePathIdentity.sourceIndexDigest).not.toBe(baseRelation.current.sourceIndexDigest);

    for (const graph of [authoredAt, edgeId, selectedSpan, sourcePath]) {
      expect(graph.semanticDigest).not.toBe(base.semanticDigest);
    }
  });

  it("looks up only exact endpoints on an authentic temporal graph", () => {
    const currentFixture = koreanSpanFixture({
      chunkText: "현재 집은 부산이다.",
      span: "현재 집은 부산이다."
    });
    const staleFixture = koreanSpanFixture({
      chunkText: "예전에 집은 서울이었다.",
      span: "예전에 집은 서울이었다."
    });
    const relation = createSupersedesRelationV1({
      authoredAt: "2026-07-21T00:00:00.000Z",
      current: { context: currentFor(currentFixture), identity: createFixtureIdentity(currentFixture) },
      edgeId: "0123456789abcdef0123456789abcdef",
      stale: { context: currentFor(staleFixture), identity: createFixtureIdentity(staleFixture) }
    });
    const graph = createTemporalClaimGraphV1({ relations: [relation] });

    const currentMatch = lookupTemporalClaimGraphEndpointV1(graph, relation.current);
    const staleMatch = lookupTemporalClaimGraphEndpointV1(graph, relation.stale);

    expect(currentMatch).toEqual({ relation, role: "current" });
    expect(currentMatch?.relation).toBe(relation);
    expect(Object.isFrozen(currentMatch)).toBe(true);
    expect(staleMatch).toEqual({ relation, role: "stale" });
    expect(staleMatch?.relation).toBe(relation);
    expect(Object.isFrozen(staleMatch)).toBe(true);

    const tamperedIdentity = {
      ...relation.current,
      spanHash: `${relation.current.spanHash.startsWith("0") ? "1" : "0"}${relation.current.spanHash.slice(1)}`
    };
    expect(lookupTemporalClaimGraphEndpointV1(graph, tamperedIdentity)).toBeUndefined();

    const unbrandedGraph = JSON.parse(JSON.stringify(graph)) as typeof graph;
    expect(lookupTemporalClaimGraphEndpointV1(unbrandedGraph, relation.current)).toBeUndefined();
  });

  it("rejects an oversized relations proxy before enumerating its keys", () => {
    const currentFixture = koreanSpanFixture({
      chunkText: "현재 집은 부산이다.",
      span: "현재 집은 부산이다."
    });
    const staleFixture = koreanSpanFixture({
      chunkText: "예전에 집은 서울이었다.",
      span: "예전에 집은 서울이었다."
    });
    const relation = createSupersedesRelationV1({
      authoredAt: "2026-07-21T00:00:00.000Z",
      current: { context: currentFor(currentFixture), identity: createFixtureIdentity(currentFixture) },
      edgeId: "0123456789abcdef0123456789abcdef",
      stale: { context: currentFor(staleFixture), identity: createFixtureIdentity(staleFixture) }
    });
    let ownKeysCalls = 0;
    const relations = new Proxy(Array.from({ length: 1_025 }, () => relation), {
      ownKeys(target) {
        ownKeysCalls += 1;
        return Reflect.ownKeys(target);
      }
    });
    let error: unknown;

    try {
      createTemporalClaimGraphV1({ relations });
    } catch (cause) {
      error = cause;
    }

    expect(error).toMatchObject({
      code: "RECALL_NOTE_SPAN_INVALID",
      message: "Note span identity input is invalid.",
      name: "NoteSpanIdentityError",
      stack: "NoteSpanIdentityError: Note span identity input is invalid."
    });
    expect(ownKeysCalls).toBe(0);
  });

  it("rejects every shared endpoint so the graph remains a disjoint directed matching", () => {
    const endpointFor = (text: string) => {
      const fixture = koreanSpanFixture({ chunkText: text, span: text });
      return { context: currentFor(fixture), identity: createFixtureIdentity(fixture) };
    };
    const currentA = endpointFor("현재 집은 부산이다.");
    const currentB = endpointFor("현재 사무실은 강남이다.");
    const staleA = endpointFor("예전에 집은 서울이었다.");
    const staleB = endpointFor("예전에 사무실은 종로였다.");
    const relationFor = (edgeId: string, current: typeof currentA, stale: typeof staleA) =>
      createSupersedesRelationV1({
        authoredAt: "2026-07-21T00:00:00.000Z",
        current,
        edgeId,
        stale
      });
    const cases = [
      {
        name: "fork / shared current",
        relations: [
          relationFor("11111111111111111111111111111111", currentA, staleA),
          relationFor("22222222222222222222222222222222", currentA, staleB)
        ]
      },
      {
        name: "merge / shared stale",
        relations: [
          relationFor("33333333333333333333333333333333", currentA, staleA),
          relationFor("44444444444444444444444444444444", currentB, staleA)
        ]
      },
      {
        name: "parallel same endpoint pair",
        relations: [
          relationFor("55555555555555555555555555555555", currentA, staleA),
          relationFor("66666666666666666666666666666666", currentA, staleA)
        ]
      }
    ] as const;

    for (const entry of cases) {
      expect(
        () => createTemporalClaimGraphV1({ relations: entry.relations }),
        entry.name
      ).toThrow(NoteSpanIdentityError);
    }
  });
});
