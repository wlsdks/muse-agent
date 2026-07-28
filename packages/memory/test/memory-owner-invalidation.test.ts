import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  beliefProvenanceSourceId,
  BeliefProvenanceResolutionError,
  FileBeliefProvenanceStore,
  FileUserMemoryStore,
  normalizeMemoryKey,
  projectFactRecallLifecycle,
  projectTemporalBeliefProvenance,
  UserMemoryOwnerControlError,
  type BeliefProvenance,
  type UserMemoryInvalidationCoordinator
} from "../src/index.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "muse-owner-invalidation-"));
  directories.push(directory);
  const memoryFile = join(directory, "user-memory.json");
  const provenanceFile = join(directory, "belief-provenance.json");
  const now = new Date("2026-07-30T12:00:00.000Z");
  return {
    memory: new FileUserMemoryStore({ file: memoryFile, now: () => now }),
    memoryFile,
    provenance: new FileBeliefProvenanceStore(provenanceFile),
    provenanceFile
  };
}

function assertion(over: Partial<BeliefProvenance> = {}): BeliefProvenance {
  return {
    key: "home_city",
    kind: "fact",
    learnedAt: "2026-04-01T12:00:00.000Z",
    source: "user",
    userId: "owner",
    value: "Seoul",
    ...over
  };
}

function invalidationCoordinator(
  provenance: FileBeliefProvenanceStore
): UserMemoryInvalidationCoordinator {
  return {
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
}

describe("owner fact invalidation", () => {
  it("removes one exact fact from active recall while preserving flat memory and temporal history", async () => {
    const { memory, memoryFile, provenance, provenanceFile } = await fixture();
    await memory.upsertFact("owner", "home_city", "Seoul");
    await memory.upsertFact("owner", "work_city", "Busan");
    await memory.upsertPreference("owner", "coffee", "filter");
    const original = assertion();
    await provenance.recordMany([
      original,
      assertion({ key: "work_city", value: "Busan" }),
      assertion({ key: "coffee", kind: "preference", value: "filter" })
    ]);
    const target = (await memory.inspectOwnerMemory("owner"))
      .find((entry) => entry.key === "home_city")!;
    const beforeMemory = await readFile(memoryFile, "utf8");

    const receipt = await memory.invalidateOwnerFact("owner", {
      exactId: target.exactId,
      expectedVersion: target.version,
      requestId: "invalidate-home-city-v1"
    }, invalidationCoordinator(provenance));

    expect(receipt).toEqual({
      action: "invalidate",
      createdAt: "2026-07-30T12:00:00.000Z",
      exactId: target.exactId,
      expectedVersion: target.version,
      key: "home_city",
      requestId: "invalidate-home-city-v1",
      sourceId: expect.stringMatching(/^bps_v1_[a-f0-9]{32}$/u),
      status: "applied"
    });
    expect(await readFile(memoryFile, "utf8")).toBe(beforeMemory);
    expect(await memory.findByUserId("owner")).toMatchObject({
      facts: { home_city: "Seoul", work_city: "Busan" },
      preferences: { coffee: "filter" }
    });

    const history = await provenance.query("owner");
    const invalidation = history.find((entry) =>
      entry.ownerResolution?.requestId === "invalidate-home-city-v1"
    )!;
    expect(invalidation).toMatchObject({
      invalidation: true,
      key: "home_city",
      kind: "fact",
      ownerResolution: {
        action: "invalidate",
        exactId: target.exactId,
        expectedVersion: target.version,
        requestId: "invalidate-home-city-v1"
      },
      source: "user",
      value: ""
    });
    expect(beliefProvenanceSourceId(invalidation)).toBe(receipt.sourceId);
    expect(beliefProvenanceSourceId(original)).toBe("bps_v1_265038efa9a64e609c130f70e2187f97");
    expect(history).toContainEqual(original);
    expect(projectFactRecallLifecycle([target], history, { normalizeKey: normalizeMemoryKey }))
      .toEqual([expect.objectContaining({
        eligibility: "ineligible",
        reason: "active-invalidation",
        state: "invalidated"
      })]);
    expect(projectTemporalBeliefProvenance("owner", history, { normalizeKey: normalizeMemoryKey }))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: "assertion",
          invalidatedAt: "2026-07-30T12:00:00.000Z",
          temporalState: "historical",
          value: "Seoul"
        }),
        expect.objectContaining({
          event: "invalidation",
          sourceId: receipt.sourceId,
          temporalState: "invalidated"
        })
      ]));
    expect(await readFile(provenanceFile, "utf8")).toContain("\"action\": \"invalidate\"");

    const laterCorrection = assertion({
      learnedAt: "2026-08-01T12:00:00.000Z",
      source: "user",
      value: "Incheon"
    });
    expect(projectFactRecallLifecycle(
      [target],
      [...history, laterCorrection],
      { normalizeKey: normalizeMemoryKey }
    )).toEqual([expect.objectContaining({
      eligibility: "ineligible",
      reason: "newer-authoritative-value",
      state: "superseded"
    })]);
    expect(projectTemporalBeliefProvenance(
      "owner",
      [...history, laterCorrection],
      { normalizeKey: normalizeMemoryKey }
    ).find((event) => event.sourceId === receipt.sourceId)).toEqual(expect.objectContaining({
      event: "invalidation",
      invalidatedAt: "2026-08-01T12:00:00.000Z",
      temporalState: "historical"
    }));
  });

  it("replays byte-identically and a failed provenance append leaves memory unchanged for retry", async () => {
    const { memory, memoryFile, provenance, provenanceFile } = await fixture();
    await memory.upsertFact("owner", "home_city", "Seoul");
    await provenance.record(assertion());
    const target = (await memory.inspectOwnerMemory("owner"))[0]!;
    const input = {
      exactId: target.exactId,
      expectedVersion: target.version,
      requestId: "invalidate-home-city-retry"
    };
    const beforeFailureMemory = await readFile(memoryFile, "utf8");
    const beforeFailureProvenance = await readFile(provenanceFile, "utf8");

    await expect(memory.invalidateOwnerFact("owner", input, {
      record: async () => {
        throw new Error("injected provenance failure");
      }
    })).rejects.toThrow("injected provenance failure");
    expect(await readFile(memoryFile, "utf8")).toBe(beforeFailureMemory);
    expect(await readFile(provenanceFile, "utf8")).toBe(beforeFailureProvenance);

    const first = await memory.invalidateOwnerFact(
      "owner",
      input,
      invalidationCoordinator(provenance)
    );
    const afterMemory = await readFile(memoryFile, "utf8");
    const afterProvenance = await readFile(provenanceFile, "utf8");
    const replay = await memory.invalidateOwnerFact(
      "owner",
      input,
      invalidationCoordinator(provenance)
    );
    expect(replay).toEqual(first);
    expect(await readFile(memoryFile, "utf8")).toBe(afterMemory);
    expect(await readFile(provenanceFile, "utf8")).toBe(afterProvenance);
  });

  it("rejects fuzzy, stale, preference, and reused targets without unrelated writes", async () => {
    const { memory, memoryFile, provenance, provenanceFile } = await fixture();
    await memory.upsertFact("owner", "home_city", "Seoul");
    await memory.upsertFact("owner", "work_city", "Busan");
    await memory.upsertPreference("owner", "coffee", "filter");
    await provenance.recordMany([
      assertion(),
      assertion({ key: "work_city", value: "Busan" }),
      assertion({ key: "coffee", kind: "preference", value: "filter" })
    ]);
    const entries = await memory.inspectOwnerMemory("owner");
    const home = entries.find((entry) => entry.key === "home_city")!;
    const work = entries.find((entry) => entry.key === "work_city")!;
    const preference = entries.find((entry) => entry.key === "coffee")!;
    const coordinator = invalidationCoordinator(provenance);
    const before = await readFile(provenanceFile, "utf8");

    await expect(memory.invalidateOwnerFact("owner", {
      exactId: "home_city",
      expectedVersion: 1,
      requestId: "invalidate-fuzzy-city"
    }, coordinator)).rejects.toSatisfy((error: unknown) =>
      error instanceof UserMemoryOwnerControlError && error.code === "exact-id-required"
    );
    await expect(memory.invalidateOwnerFact("owner", {
      exactId: home.exactId,
      expectedVersion: home.version + 1,
      requestId: "invalidate-stale-city"
    }, coordinator)).rejects.toSatisfy((error: unknown) =>
      error instanceof UserMemoryOwnerControlError && error.code === "conflict"
    );
    await expect(memory.invalidateOwnerFact("owner", {
      exactId: preference.exactId,
      expectedVersion: preference.version,
      requestId: "invalidate-preference"
    }, coordinator)).rejects.toSatisfy((error: unknown) =>
      error instanceof UserMemoryOwnerControlError && error.code === "invalid-request"
    );
    expect(await readFile(provenanceFile, "utf8")).toBe(before);

    await memory.invalidateOwnerFact("owner", {
      exactId: home.exactId,
      expectedVersion: home.version,
      requestId: "invalidate-reused-request"
    }, coordinator);
    const beforeReuseMemory = await readFile(memoryFile, "utf8");
    const beforeReuseProvenance = await readFile(provenanceFile, "utf8");
    await expect(memory.invalidateOwnerFact("owner", {
      exactId: work.exactId,
      expectedVersion: work.version,
      requestId: "invalidate-reused-request"
    }, coordinator)).rejects.toSatisfy((error: unknown) =>
      error instanceof BeliefProvenanceResolutionError && error.code === "request-reused"
    );
    expect(await readFile(memoryFile, "utf8")).toBe(beforeReuseMemory);
    expect(await readFile(provenanceFile, "utf8")).toBe(beforeReuseProvenance);
  });

  it("fails closed on corrupt provenance without changing either source", async () => {
    const { memory, memoryFile, provenance, provenanceFile } = await fixture();
    await memory.upsertFact("owner", "home_city", "Seoul");
    const target = (await memory.inspectOwnerMemory("owner"))[0]!;
    await writeFile(provenanceFile, `${JSON.stringify({
      entries: [assertion(), { malformed: true }]
    }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    const beforeMemory = await readFile(memoryFile, "utf8");
    const beforeProvenance = await readFile(provenanceFile, "utf8");

    await expect(memory.invalidateOwnerFact("owner", {
      exactId: target.exactId,
      expectedVersion: target.version,
      requestId: "invalidate-corrupt-source"
    }, invalidationCoordinator(provenance))).rejects.toSatisfy((error: unknown) =>
      error instanceof BeliefProvenanceResolutionError && error.code === "invalid-request"
    );
    expect(await readFile(memoryFile, "utf8")).toBe(beforeMemory);
    expect(await readFile(provenanceFile, "utf8")).toBe(beforeProvenance);
  });
});
