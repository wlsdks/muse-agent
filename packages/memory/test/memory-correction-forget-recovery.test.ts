import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  beliefProvenanceSourceId,
  FileBeliefProvenanceStore,
  FileUserMemoryStore,
  normalizeMemoryKey,
  projectFactRecallLifecycle,
  projectTemporalBeliefProvenance,
  recordRetraction,
  type BeliefProvenance,
  type UserMemoryInvalidationCoordinator
} from "../src/index.js";

describe("correction → invalidation → forget → recovery", () => {
  it("preserves exact sources without stale resurrection or unrelated fact loss", async () => {
    const directory = await mkdtemp(join(tmpdir(), "muse-memory-recovery-"));
    try {
      let now = new Date("2026-08-01T10:00:00.000Z");
      const memory = new FileUserMemoryStore({
        file: join(directory, "user-memory.json"),
        now: () => now
      });
      const provenance = new FileBeliefProvenanceStore(
        join(directory, "belief-provenance.json")
      );
      const setNow = (value: string): void => {
        now = new Date(value);
      };
      const assertion = (
        key: string,
        value: string,
        learnedAt: string
      ): BeliefProvenance => ({
        key,
        kind: "fact",
        learnedAt,
        source: "user",
        userId: "owner",
        value
      });
      const coordinator: UserMemoryInvalidationCoordinator = {
        record: async ({ createdAt, expectedVersion, requestId, target, userId }) => {
          const persisted = await provenance.recordOwnerInvalidation({
            createdAt,
            exactId: target.exactId,
            expectedVersion,
            key: target.key,
            requestId,
            userId
          });
          return {
            createdAt: persisted.learnedAt,
            sourceId: beliefProvenanceSourceId(persisted)
          };
        }
      };

      await memory.upsertFact("owner", "home_city", "Seoul");
      await memory.upsertFact("owner", "work_city", "Daejeon");
      const initialHome = assertion("home_city", "Seoul", now.toISOString());
      const initialWork = assertion("work_city", "Daejeon", now.toISOString());
      await provenance.recordMany([initialHome, initialWork]);
      const initialEntries = await memory.inspectOwnerMemory("owner");
      const home = initialEntries.find((entry) => entry.key === "home_city")!;
      const work = initialEntries.find((entry) => entry.key === "work_city")!;
      const initialSourceIds = new Set([
        beliefProvenanceSourceId(initialHome),
        beliefProvenanceSourceId(initialWork)
      ]);

      setNow("2026-08-02T10:00:00.000Z");
      const correction = await memory.correctOwnerMemory("owner", {
        exactId: home.exactId,
        expectedVersion: home.version,
        requestId: "correct-home-city-busan",
        value: "Busan"
      });
      const corrected = assertion("home_city", "Busan", correction.createdAt);
      await provenance.record(corrected);
      const correctedSourceId = beliefProvenanceSourceId(corrected);

      setNow("2026-08-03T10:00:00.000Z");
      const invalidation = await memory.invalidateOwnerFact("owner", {
        exactId: home.exactId,
        expectedVersion: correction.after.version,
        requestId: "invalidate-home-city-current"
      }, coordinator);

      setNow("2026-08-04T10:00:00.000Z");
      const forgotten = await memory.forgetOwnerMemory("owner", {
        exactId: home.exactId,
        expectedVersion: correction.after.version,
        requestId: "forget-home-city-current",
        undoTtlMs: 7 * 24 * 60 * 60 * 1_000
      });
      await recordRetraction(provenance, "owner", "home_city", {
        kind: "fact",
        nowIso: forgotten.createdAt
      });

      const whileForgotten = await provenance.query("owner");
      const retraction = whileForgotten.find((entry) => entry.retraction === true)!;
      const retractionSourceId = beliefProvenanceSourceId(retraction);
      expect((await memory.findByUserId("owner"))?.facts).toEqual({
        work_city: "Daejeon"
      });
      expect((await memory.inspectOwnerMemory("owner")).find(
        (entry) => entry.exactId === work.exactId
      )).toEqual(work);
      expect(projectFactRecallLifecycle([
        { ...home, value: "Busan", version: correction.after.version }
      ], whileForgotten, { normalizeKey: normalizeMemoryKey })).toEqual([
        expect.objectContaining({
          eligibility: "ineligible",
          reason: "active-retraction",
          state: "deleted"
        })
      ]);

      setNow("2026-08-05T10:00:00.000Z");
      const recovered = await memory.undoOwnerMemory("owner", forgotten.receiptId);
      const recoveredAt = recovered.undo!.undoneAt;
      const recovery = assertion("home_city", recovered.before.value, recoveredAt);
      await provenance.record(recovery);

      const restoredHome = (await memory.inspectOwnerMemory("owner")).find(
        (entry) => entry.exactId === home.exactId
      )!;
      const finalHistory = await provenance.query("owner");
      const finalSourceIds = new Set(finalHistory.map(beliefProvenanceSourceId));
      expect(restoredHome).toMatchObject({
        exactId: home.exactId,
        key: "home_city",
        value: "Busan",
        version: 4
      });
      expect((await memory.inspectOwnerMemory("owner")).find(
        (entry) => entry.exactId === work.exactId
      )).toEqual(work);
      expect(projectFactRecallLifecycle(
        [restoredHome],
        finalHistory,
        { normalizeKey: normalizeMemoryKey }
      )).toEqual([
        expect.objectContaining({
          eligibility: "eligible",
          reason: "explicit-user-current",
          state: "active"
        })
      ]);
      expect(projectFactRecallLifecycle(
        [{ ...restoredHome, value: "Seoul" }],
        finalHistory,
        { normalizeKey: normalizeMemoryKey }
      )).toEqual([
        expect.objectContaining({
          eligibility: "ineligible",
          reason: "newer-authoritative-value",
          state: "superseded"
        })
      ]);
      for (const sourceId of [
        ...initialSourceIds,
        correctedSourceId,
        invalidation.sourceId,
        retractionSourceId
      ]) {
        expect(finalSourceIds.has(sourceId)).toBe(true);
      }
      expect(finalHistory.filter((entry) => entry.key === "work_city"))
        .toEqual([initialWork]);

      const temporal = projectTemporalBeliefProvenance(
        "owner",
        finalHistory,
        { normalizeKey: normalizeMemoryKey }
      );
      expect(temporal.find((event) => event.sourceId === retractionSourceId))
        .toMatchObject({ temporalState: "historical" });
      expect(temporal.find((event) => event.sourceId === invalidation.sourceId))
        .toMatchObject({ temporalState: "historical" });
      expect(temporal.find((event) => event.sourceId === correctedSourceId))
        .toMatchObject({ temporalState: "historical", value: "Busan" });
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
