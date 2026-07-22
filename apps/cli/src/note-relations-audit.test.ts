import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createNoteSpanIdentityV1, createSupersedesRelationV1 } from "@muse/recall";
import { describe, expect, it } from "vitest";

import { auditNoteRelationsStore, temporalClaimGraphFromAuditV1 } from "./note-relations-audit.js";
import { loadBoundedNotesIndex, loadIndexedNoteSource } from "./note-relations-context.js";
import { mutateNoteRelationsStore, resolveNoteRelationsPathSnapshot } from "./note-relations-store.js";

async function setupRelation() {
  const home = await mkdtemp(join(tmpdir(), "muse-relations-audit-"));
  const paths = resolveNoteRelationsPathSnapshot({ HOME: home });
  await mkdir(paths.notesDir, { recursive: true, mode: 0o700 });
  const sourcePath = join(paths.notesDir, "facts.md");
  const source = "Current answer\n\nUsed to be old answer";
  await writeFile(sourcePath, source, { mode: 0o600 });
  const index = {
    version: 2,
    model: "fixture",
    builtAtIso: "2026-07-21T00:00:00.000Z",
    embeddingCount: 2,
    embeddingDim: 3,
    files: [{
      path: sourcePath,
      mtimeMs: 1,
      sourceHash: createHash("sha256").update(source).digest("hex"),
      chunkerVersion: "muse.notes.chunk-text.v1",
      chunks: [
        { file: sourcePath, chunkIndex: 0, text: "Current answer" },
        { file: sourcePath, chunkIndex: 1, text: "Used to be old answer" }
      ]
    }]
  };
  await writeFile(paths.notesIndexFile, JSON.stringify(index), { mode: 0o600 });
  const loadedIndex = await loadBoundedNotesIndex(paths);
  const loaded = await loadIndexedNoteSource(loadedIndex, "facts.md");
  if (loaded.status !== "resolved") throw new Error("fixture did not resolve");
  const current = createNoteSpanIdentityV1({
    sourceBytes: loaded.sourceBytes,
    sourceIndex: loaded.sourceIndex,
    chunkIndex: 0,
    start: 0,
    end: Buffer.byteLength("Current answer")
  });
  const stale = createNoteSpanIdentityV1({
    sourceBytes: loaded.sourceBytes,
    sourceIndex: loaded.sourceIndex,
    chunkIndex: 1,
    start: 0,
    end: Buffer.byteLength("Used to be old answer")
  });
  const relation = createSupersedesRelationV1({
    authoredAt: "2026-07-21T00:00:00.000Z",
    current: { context: { sourceBytes: loaded.sourceBytes, sourceIndex: loaded.sourceIndex }, identity: current },
    edgeId: "1".repeat(32),
    stale: { context: { sourceBytes: loaded.sourceBytes, sourceIndex: loaded.sourceIndex }, identity: stale }
  });
  await mutateNoteRelationsStore(paths, () => [relation]);
  return { paths, relation, sourcePath };
}

describe("note relations audit", () => {
  it("reconstructs authority only through public recall constructors", async () => {
    const { paths, relation } = await setupRelation();
    const audit = await auditNoteRelationsStore(paths);
    expect(audit).toMatchObject({ state: "valid", revision: 1 });
    expect(audit.edges).toEqual([{ edgeId: relation.edgeId, status: "valid" }]);
    expect(audit.semanticDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(temporalClaimGraphFromAuditV1(audit)?.semanticDigest).toBe(audit.semanticDigest);
  });

  it("retains a stale stored edge as unavailable without rewriting it", async () => {
    const { paths, relation, sourcePath } = await setupRelation();
    await writeFile(sourcePath, "Changed answer", { mode: 0o600 });
    const audit = await auditNoteRelationsStore(paths);
    expect(audit).toMatchObject({ state: "unavailable", semanticDigest: null });
    expect(audit.edges).toEqual([{ edgeId: relation.edgeId, reason: "stale_endpoint", status: "unavailable" }]);
    expect(temporalClaimGraphFromAuditV1(audit)).toBeUndefined();
    const after = await (await import("./note-relations-store.js")).readNoteRelationsStore(paths);
    expect(after.relations).toHaveLength(1);
    expect(after.revision).toBe(1);
  });

  it("marks a full graph unavailable when otherwise valid edges reuse an endpoint", async () => {
    const { paths, relation } = await setupRelation();
    const duplicateEndpoint = { ...relation, edgeId: "2".repeat(32) };
    await mutateNoteRelationsStore(paths, () => [relation, duplicateEndpoint]);
    const audit = await auditNoteRelationsStore(paths);
    expect(audit.state).toBe("unavailable");
    expect(audit.edges).toEqual([
      { edgeId: "1".repeat(32), reason: "disjoint_conflict", status: "unavailable" },
      { edgeId: "2".repeat(32), reason: "disjoint_conflict", status: "unavailable" }
    ]);
  });

  it("reports explicit marker-direction failure for a structurally valid reversed edge", async () => {
    const { paths, relation } = await setupRelation();
    await mutateNoteRelationsStore(paths, () => [{
      ...relation,
      current: relation.stale,
      stale: relation.current
    }]);
    const audit = await auditNoteRelationsStore(paths);
    expect(audit.edges).toEqual([{
      edgeId: relation.edgeId,
      reason: "marker_direction",
      status: "unavailable"
    }]);
  });
});
