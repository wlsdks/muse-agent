import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  activateTemporalClaimGraphV1,
  createNoteSpanIdentityV1,
  createSupersedesRelationV1,
  createTemporalClaimGraphV1,
  retrieveAndRankNotes,
  temporalClaimSnapshotMatchesContextV1,
  type NoteSourceIndexViewV1,
  type RecallRerankFn
} from "./index.js";

const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

function endpoint(sourcePath: string, text: string) {
  const sourceBytes = Buffer.from(text);
  const sourceIndex: NoteSourceIndexViewV1 = {
    chunkerVersion: "muse.notes.chunk-text.v1",
    chunks: [{ chunkIndex: 0, text }],
    notesIndexSchema: 2,
    sourceHash: sha256(sourceBytes),
    sourcePath
  };
  const identity = createNoteSpanIdentityV1({
    sourceBytes,
    sourceIndex,
    chunkIndex: 0,
    start: 0,
    end: Buffer.byteLength(text)
  });
  return { identity, sourceBytes, sourceIndex, text };
}

async function graphFixture() {
  const root = await mkdtemp(join(tmpdir(), "muse-temporal-retrieval-"));
  const current = endpoint("current.md", "Office gym membership is active");
  const stale = endpoint("stale.md", "I used to have an office gym membership");
  const currentPath = join(root, "current.md");
  const stalePath = join(root, "stale.md");
  const distractPath = join(root, "distract.md");
  await Promise.all([
    writeFile(currentPath, current.text),
    writeFile(stalePath, stale.text),
    writeFile(distractPath, "Office lunch menu")
  ]);
  const relation = createSupersedesRelationV1({
    authoredAt: "2026-07-21T00:00:00.000Z",
    current: { context: { sourceBytes: current.sourceBytes, sourceIndex: current.sourceIndex }, identity: current.identity },
    edgeId: "1".repeat(32),
    stale: { context: { sourceBytes: stale.sourceBytes, sourceIndex: stale.sourceIndex }, identity: stale.identity }
  });
  const graph = createTemporalClaimGraphV1({ relations: [relation] });
  const indexFiles = [
    { path: currentPath, mtimeMs: 1, sourceHash: current.sourceIndex.sourceHash, chunkerVersion: current.sourceIndex.chunkerVersion, chunks: [{ file: currentPath, chunkIndex: 0, text: current.text, embedding: [1, 0] }] },
    { path: distractPath, mtimeMs: 1, chunks: [{ file: distractPath, chunkIndex: 0, text: "Office lunch menu", embedding: [0.95, 0.05] }] },
    { path: stalePath, mtimeMs: 1, sourceHash: stale.sourceIndex.sourceHash, chunkerVersion: stale.sourceIndex.chunkerVersion, chunks: [{ file: stalePath, chunkIndex: 0, text: stale.text, embedding: [0.8, 0.2] }] }
  ];
  const candidates = indexFiles.flatMap((file) => file.chunks.map((chunk) => ({
    chunk,
    file: file.path,
    score: chunk.embedding[0]!
  })));
  return { candidates, currentPath, graph, indexFiles, relation, root, stalePath };
}

describe("explicit temporal graph retrieval activation", () => {
  it("promotes the exact current/stale endpoints from a confident top-1 seed", async () => {
    const fixture = await graphFixture();
    const activated = activateTemporalClaimGraphV1({
      candidates: fixture.candidates,
      confidentAt: 0.7,
      graph: fixture.graph,
      indexFiles: fixture.indexFiles,
      notesDir: fixture.root,
      query: "office gym membership",
      topK: 2
    });
    expect(activated?.scored.map((candidate) => candidate.file)).toEqual([fixture.currentPath, fixture.stalePath]);
    expect(activated?.verifiedCorrectionPair).toEqual({
      current: { chunkIndex: 0, file: fixture.currentPath },
      stale: { chunkIndex: 0, file: fixture.stalePath }
    });
    expect(activated?.relation).toBe(fixture.relation);
  });

  it("is inert for historical intent, lexical misses, score ties, and topK below two", async () => {
    const fixture = await graphFixture();
    const base = { candidates: fixture.candidates, confidentAt: 0.7, graph: fixture.graph, indexFiles: fixture.indexFiles, notesDir: fixture.root, query: "office gym membership", topK: 2 };
    expect(activateTemporalClaimGraphV1({ ...base, query: "what was formerly my office gym membership" })).toBeUndefined();
    expect(activateTemporalClaimGraphV1({ ...base, query: "passport renewal" })).toBeUndefined();
    expect(activateTemporalClaimGraphV1({ ...base, candidates: fixture.candidates.map((candidate) => ({ ...candidate, score: 0.9 })) })).toBeUndefined();
    expect(activateTemporalClaimGraphV1({ ...base, topK: 1 })).toBeUndefined();
  });

  it("orders current before stale even when stale is top-1 and rejects ambiguous or stale provenance", async () => {
    const fixture = await graphFixture();
    const base = { candidates: fixture.candidates, confidentAt: 0.7, graph: fixture.graph, indexFiles: fixture.indexFiles, notesDir: fixture.root, query: "office gym membership", topK: 2 };
    const staleFirst = fixture.candidates.map((candidate) => ({
      ...candidate,
      score: candidate.file === fixture.stalePath ? 1 : candidate.file === fixture.currentPath ? 0.8 : 0.7
    }));
    expect(activateTemporalClaimGraphV1({ ...base, candidates: staleFirst })?.scored.map(({ file }) => file))
      .toEqual([fixture.currentPath, fixture.stalePath]);
    expect(activateTemporalClaimGraphV1({ ...base, candidates: [...fixture.candidates, fixture.candidates[0]!] })).toBeUndefined();
    const staleIndex = fixture.indexFiles.map((file) => file.path === fixture.currentPath ? { ...file, sourceHash: "0".repeat(64) } : file);
    expect(activateTemporalClaimGraphV1({ ...base, indexFiles: staleIndex })).toBeUndefined();
  });

  it("does not cross-pair unrelated edges and ignores a confident non-endpoint top-1", async () => {
    const fixture = await graphFixture();
    const otherCurrent = endpoint("other-current.md", "Project room is Harbor");
    const otherStale = endpoint("other-stale.md", "Project room used to be Cedar");
    const otherRelation = createSupersedesRelationV1({
      authoredAt: "2026-07-21T00:00:00.000Z",
      current: { context: { sourceBytes: otherCurrent.sourceBytes, sourceIndex: otherCurrent.sourceIndex }, identity: otherCurrent.identity },
      edgeId: "2".repeat(32),
      stale: { context: { sourceBytes: otherStale.sourceBytes, sourceIndex: otherStale.sourceIndex }, identity: otherStale.identity }
    });
    const graph = createTemporalClaimGraphV1({ relations: [fixture.relation, otherRelation] });
    const base = { candidates: fixture.candidates, confidentAt: 0.7, graph, indexFiles: fixture.indexFiles, notesDir: fixture.root, query: "office gym membership", topK: 2 };
    expect(activateTemporalClaimGraphV1(base)?.relation.edgeId).toBe(fixture.relation.edgeId);
    const nonEndpointFirst = fixture.candidates.map((candidate) => ({
      ...candidate,
      score: candidate.file.includes("distract") ? 1 : 0.8
    }));
    expect(activateTemporalClaimGraphV1({ ...base, candidates: nonEndpointFirst })).toBeUndefined();
  });

  it("bypasses reranker invocation and performs only the baseline query embed", async () => {
    const fixture = await graphFixture();
    const embedFn = vi.fn(async () => [1, 0]);
    const rerankFn = Object.assign(vi.fn(async () => ({ httpAttempts: 1, outcome: "error" as const })), {
      mode: "correction-pair" as const
    }) satisfies RecallRerankFn;
    const prepareRerankFn = vi.fn(async () => rerankFn);
    const result = await retrieveAndRankNotes({
      query: "office gym membership and passport renewal",
      embedModel: "fixture",
      indexFiles: fixture.indexFiles,
      notesDir: fixture.root,
      topK: 2,
      scope: undefined,
      json: true,
      onStderr: () => undefined,
      embedFn,
      prepareRerankFn,
      conflictAwareSelection: true,
      temporalClaimGraph: fixture.graph
    });
    expect(embedFn).toHaveBeenCalledTimes(1);
    expect(prepareRerankFn).not.toHaveBeenCalled();
    expect(rerankFn).not.toHaveBeenCalled();
    expect(result.scored.slice(0, 2).map((candidate) => candidate.file)).toEqual([fixture.currentPath, fixture.stalePath]);
    expect(result.verifiedCorrectionPair).toBeDefined();
  });

  it("binds a reusable snapshot to local authority and the complete selected edge", async () => {
    const fixture = await graphFixture();
    const authority = Object.freeze({
      chunkerVersion: "muse.notes.chunk-text.v1" as const,
      graphDigest: fixture.graph.semanticDigest,
      indexDigest: "2".repeat(64),
      rawStoreDigest: "3".repeat(64),
      schema: "muse.temporal-claim-snapshot-authority.v1" as const,
      sourceProvenanceDigest: "4".repeat(64),
      storeRevision: 7,
      storeState: "valid" as const
    });
    const result = await retrieveAndRankNotes({
      query: "office gym membership", embedModel: "fixture", indexFiles: fixture.indexFiles,
      notesDir: fixture.root, topK: 2, scope: undefined, json: true, onStderr: () => undefined,
      embedFn: async () => [1, 0], temporalClaimGraph: fixture.graph, temporalClaimAuthority: authority,
      snapshotIdentity: { indexBuiltAtIso: "2026-07-21T00:00:00.000Z", notesIndexFile: join(fixture.root, "notes-index.json") }
    });
    expect(result.snapshot?.identity.temporalClaim).toEqual({ authority, selectedRelation: fixture.relation });
    expect(Object.isFrozen(result.snapshot?.identity.temporalClaim)).toBe(true);
    const snapshot = result.snapshot!;
    expect(temporalClaimSnapshotMatchesContextV1(snapshot, { authority, graph: fixture.graph })).toBe(true);
    const mutations = [
      { ...authority, rawStoreDigest: "5".repeat(64) },
      { ...authority, storeRevision: 8 },
      { ...authority, storeState: "unavailable" as const },
      { ...authority, graphDigest: "5".repeat(64) },
      { ...authority, indexDigest: "5".repeat(64) },
      { ...authority, sourceProvenanceDigest: "5".repeat(64) }
    ];
    for (const changed of mutations) {
      expect(temporalClaimSnapshotMatchesContextV1(snapshot, { authority: changed, graph: fixture.graph })).toBe(false);
    }
    expect(temporalClaimSnapshotMatchesContextV1(snapshot, {
      authority,
      graph: createTemporalClaimGraphV1({ relations: [] })
    })).toBe(false);
  });

  it("keeps unrelated graph behavior byte-equivalent to graph-disabled retrieval", async () => {
    const fixture = await graphFixture();
    const run = (temporalClaimGraph?: typeof fixture.graph) => retrieveAndRankNotes({
      query: "passport renewal",
      embedModel: "fixture",
      indexFiles: fixture.indexFiles,
      notesDir: fixture.root,
      topK: 2,
      scope: undefined,
      json: true,
      onStderr: () => undefined,
      embedFn: async () => [1, 0],
      conflictAwareSelection: false,
      ...(temporalClaimGraph ? { temporalClaimGraph } : {})
    });
    expect(await run(fixture.graph)).toEqual(await run());
  });
});
