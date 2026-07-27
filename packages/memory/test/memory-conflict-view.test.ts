import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  beliefProvenanceSourceId,
  FileBeliefProvenanceStore,
  FileUserMemoryStore,
  normalizeMemoryKey,
  projectFactRecallLifecycle,
  projectMemoryConflictViews,
  UserMemoryOwnerControlError,
  type BeliefProvenance,
  type ExactUserMemoryEntry
} from "../src/index.js";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "muse-memory-conflict-"));
  const memoryFile = join(dir, "user-memory.json");
  const provenanceFile = join(dir, "belief-provenance.json");
  let now = new Date("2026-07-27T16:00:00.000Z");
  const memory = new FileUserMemoryStore({ file: memoryFile, now: () => now });
  const provenance = new FileBeliefProvenanceStore(provenanceFile);
  return {
    memory,
    memoryFile,
    provenance,
    provenanceFile,
    setNow(value: string) {
      now = new Date(value);
    }
  };
}

function bp(over: Partial<BeliefProvenance> = {}): BeliefProvenance {
  return {
    key: "home_city",
    kind: "fact",
    learnedAt: "2026-07-27T15:00:00.000Z",
    source: "auto",
    userId: "owner",
    value: "Seoul",
    ...over
  };
}

function recordKeep(
  provenance: FileBeliefProvenanceStore
): Parameters<FileUserMemoryStore["keepOwnerMemory"]>[2] {
  return {
    record: async ({ beforeVersion, createdAt, requestId, target, userId }) => {
      const persisted = await provenance.recordOwnerKeepResolution({
        createdAt,
        exactId: target.exactId,
        expectedVersion: beforeVersion,
        key: target.key,
        kind: target.kind,
        requestId,
        userId,
        value: target.value
      });
      return {
        createdAt: persisted.learnedAt,
        sourceId: beliefProvenanceSourceId(persisted)
      };
    },
    validate: async ({ target, userId }) => {
      const conflicts = projectMemoryConflictViews(
        userId,
        [target],
        await provenance.query(userId),
        { normalizeKey: normalizeMemoryKey }
      );
      if (conflicts.length !== 1) throw new Error("not an actionable conflict");
    }
  };
}

describe("memory conflict projection", () => {
  it("projects stable exact sources and current policy without cross-user or excerpt leakage", () => {
    const target: ExactUserMemoryEntry = {
      exactId: "mem_v1_11111111111111111111111111111111",
      key: "home_city",
      kind: "fact",
      value: "Busan",
      version: 1
    };
    const entries = [
      bp({ evidenceExcerpt: "owner-private-prompt", sessionId: "session-a", value: "Seoul" }),
      bp({ learnedAt: "2026-07-27T15:30:00.000Z", sessionId: "session-b", value: "Busan" }),
      bp({
        evidenceExcerpt: "OTHER-USER-SECRET",
        learnedAt: "2026-07-27T15:45:00.000Z",
        sessionId: "other-session",
        userId: "intruder",
        value: "OTHER-USER-VALUE"
      })
    ];

    const first = projectMemoryConflictViews(
      "owner",
      [target],
      entries,
      { normalizeKey: normalizeMemoryKey }
    );
    const permuted = projectMemoryConflictViews(
      "owner",
      [target],
      [entries[2]!, entries[1]!, entries[0]!],
      { normalizeKey: normalizeMemoryKey }
    );

    expect(first).toEqual(permuted);
    expect(first).toHaveLength(1);
    expect(first[0]?.currentPolicy).toMatchObject({
      eligibility: "uncertain",
      reason: "auto-values-conflict",
      state: "disputed",
      value: "Busan"
    });
    expect(first[0]?.sources.map((source) => source.sourceId))
      .toEqual(first[0]?.sources.map(() => expect.stringMatching(/^bps_v1_[a-f0-9]{32}$/u)));
    expect(first[0]?.sources.map((source) => source.value)).toEqual(["Seoul", "Busan"]);
    const serialized = JSON.stringify(first);
    expect(serialized).not.toContain("owner-private-prompt");
    expect(serialized).not.toContain("OTHER-USER");
    expect(serialized).not.toContain("\"userId\"");
  });

  it("fails an equal-timestamp explicit-user conflict closed independent of input order", () => {
    const candidate = [{ key: "home_city", kind: "fact" as const, value: "Busan" }];
    const entries = [
      bp({ source: "user", value: "Seoul" }),
      bp({ source: "user", value: "Busan" })
    ];
    const expected = [
      expect.objectContaining({
        eligibility: "uncertain",
        reason: "equal-authority-conflict",
        state: "disputed"
      })
    ];
    expect(projectFactRecallLifecycle(candidate, entries)).toEqual(expected);
    expect(projectFactRecallLifecycle(candidate, [...entries].reverse())).toEqual(expected);
  });

  it("keeps equal-timestamp auto conflicts disputed independent of input order", () => {
    const candidate = [{ key: "home_city", kind: "fact" as const, value: "Busan" }];
    const entries = [bp({ value: "Seoul" }), bp({ value: "Busan" })];
    const forward = projectFactRecallLifecycle(candidate, entries);
    const reverse = projectFactRecallLifecycle(candidate, [...entries].reverse());
    expect(forward).toEqual(reverse);
    expect(forward).toEqual([
      expect.objectContaining({
        eligibility: "uncertain",
        reason: "auto-values-conflict",
        state: "disputed"
      })
    ]);
  });

  it("shows the authoritative source value rather than the stale flat-store value", () => {
    const target: ExactUserMemoryEntry = {
      exactId: "mem_v1_22222222222222222222222222222222",
      key: "home_city",
      kind: "fact",
      value: "Seoul",
      version: 1
    };
    const authoritative = bp({
      learnedAt: "2026-07-27T15:30:00.000Z",
      source: "user",
      value: "Busan"
    });
    const view = projectMemoryConflictViews(
      "owner",
      [target],
      [bp({ value: "Seoul" }), authoritative],
      { normalizeKey: normalizeMemoryKey }
    )[0]!;

    expect(view.currentPolicy).toMatchObject({
      eligibility: "ineligible",
      reason: "newer-authoritative-value",
      sourceId: beliefProvenanceSourceId(authoritative),
      state: "superseded",
      value: "Busan"
    });
  });

  it("selects an equal-timestamp same-value authoritative source independent of input order", () => {
    const target: ExactUserMemoryEntry = {
      exactId: "mem_v1_33333333333333333333333333333333",
      key: "home_city",
      kind: "fact",
      value: "Seoul",
      version: 1
    };
    const entries = [
      bp({ evidenceExcerpt: "private-a", sessionId: "session-a", source: "user", value: "Busan" }),
      bp({ evidenceExcerpt: "private-b", sessionId: "session-b", source: "user", value: "Busan" })
    ];

    expect(projectMemoryConflictViews("owner", [target], entries))
      .toEqual(projectMemoryConflictViews("owner", [target], [...entries].reverse()));
  });

  it("assigns distinct exact IDs to events that differ only by hidden evidence", () => {
    expect(beliefProvenanceSourceId(bp({ evidenceExcerpt: "private-a" })))
      .not.toBe(beliefProvenanceSourceId(bp({ evidenceExcerpt: "private-b" })));
  });
});

describe("FileUserMemoryStore keep conflict coordination", () => {
  it("keeps once, increments the exact version, replays byte-identically, and resolves the reducer conflict", async () => {
    const { memory, memoryFile, provenance, provenanceFile } = await fixture();
    await memory.upsertFact("owner", "home_city", "Busan");
    await provenance.recordMany([
      bp({ value: "Seoul" }),
      bp({ learnedAt: "2026-07-27T15:30:00.000Z", value: "Busan" })
    ]);
    const target = (await memory.inspectOwnerMemory("owner"))[0]!;

    const beforeMemory = await readFile(memoryFile, "utf8");
    const beforeProvenance = await readFile(provenanceFile, "utf8");
    expect(projectMemoryConflictViews(
      "owner",
      [target],
      await provenance.query("owner"),
      { normalizeKey: normalizeMemoryKey }
    )).toHaveLength(1);
    expect(await readFile(memoryFile, "utf8")).toBe(beforeMemory);
    expect(await readFile(provenanceFile, "utf8")).toBe(beforeProvenance);

    const input = {
      exactId: target.exactId,
      expectedVersion: target.version,
      requestId: "keep-home-city-v1"
    };
    const first = await memory.keepOwnerMemory("owner", input, recordKeep(provenance));
    expect(first).toMatchObject({
      afterVersion: 2,
      beforeVersion: 1,
      sourceId: expect.stringMatching(/^bps_v1_[a-f0-9]{32}$/u),
      status: "applied",
      target: { version: 2 }
    });
    expect((await memory.inspectOwnerMemory("owner"))[0]?.version).toBe(2);
    expect(projectMemoryConflictViews(
      "owner",
      await memory.inspectOwnerMemory("owner"),
      await provenance.query("owner"),
      { normalizeKey: normalizeMemoryKey }
    )).toEqual([]);

    const afterFirstMemory = await readFile(memoryFile, "utf8");
    const afterFirstProvenance = await readFile(provenanceFile, "utf8");
    await expect(memory.keepOwnerMemory("owner", input, recordKeep(provenance))).resolves.toEqual(first);
    expect(await readFile(memoryFile, "utf8")).toBe(afterFirstMemory);
    expect(await readFile(provenanceFile, "utf8")).toBe(afterFirstProvenance);
    expect((await provenance.query("owner")).filter((entry) => entry.ownerResolution)).toHaveLength(1);
  });

  it("leaves a retryable pending receipt on provenance failure and blocks other mutations until replay", async () => {
    const { memory, provenance } = await fixture();
    await memory.upsertFact("owner", "home_city", "Busan");
    await provenance.recordMany([
      bp({ value: "Seoul" }),
      bp({ learnedAt: "2026-07-27T15:30:00.000Z", value: "Busan" })
    ]);
    const target = (await memory.inspectOwnerMemory("owner"))[0]!;
    const input = {
      exactId: target.exactId,
      expectedVersion: target.version,
      requestId: "keep-home-city-fault"
    };
    const coordinator = recordKeep(provenance);
    await expect(memory.keepOwnerMemory("owner", input, {
      ...coordinator,
      record: async () => {
        throw new Error("injected provenance failure");
      }
    })).rejects.toThrow("injected provenance failure");
    expect((await memory.inspectOwnerMemory("owner"))[0]?.version).toBe(2);
    await expect(memory.correctOwnerMemory("owner", {
      exactId: target.exactId,
      expectedVersion: 2,
      requestId: "correct-while-keep-pending",
      value: "Seoul"
    })).rejects.toSatisfy((error: unknown) =>
      error instanceof UserMemoryOwnerControlError && error.code === "conflict"
    );
    await expect(memory.keepOwnerMemory("owner", input, recordKeep(provenance)))
      .resolves.toMatchObject({ status: "applied" });
  });

  it("allows exactly one of concurrent keep and correction from the same expected version", async () => {
    const { memory, provenance } = await fixture();
    await memory.upsertFact("owner", "home_city", "Busan");
    await provenance.recordMany([
      bp({ value: "Seoul" }),
      bp({ learnedAt: "2026-07-27T15:30:00.000Z", value: "Busan" })
    ]);
    const target = (await memory.inspectOwnerMemory("owner"))[0]!;

    const results = await Promise.allSettled([
      memory.keepOwnerMemory("owner", {
        exactId: target.exactId,
        expectedVersion: target.version,
        requestId: "keep-concurrent-city"
      }, recordKeep(provenance)),
      memory.correctOwnerMemory("owner", {
        exactId: target.exactId,
        expectedVersion: target.version,
        requestId: "correct-concurrent-city",
        value: "Incheon"
      })
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((await memory.inspectOwnerMemory("owner"))[0]?.version).toBe(2);
  });

  it("rejects fuzzy and stale keep targets before provenance changes", async () => {
    const { memory, provenance, provenanceFile } = await fixture();
    await memory.upsertFact("owner", "home_city", "Busan");
    await provenance.recordMany([
      bp({ value: "Seoul" }),
      bp({ learnedAt: "2026-07-27T15:30:00.000Z", value: "Busan" })
    ]);
    const target = (await memory.inspectOwnerMemory("owner"))[0]!;
    const before = await readFile(provenanceFile, "utf8");

    await expect(memory.keepOwnerMemory("owner", {
      exactId: "home_city",
      expectedVersion: 1,
      requestId: "keep-fuzzy-home-city"
    }, recordKeep(provenance))).rejects.toSatisfy((error: unknown) =>
      error instanceof UserMemoryOwnerControlError && error.code === "exact-id-required"
    );
    expect(await readFile(provenanceFile, "utf8")).toBe(before);

    await memory.correctOwnerMemory("owner", {
      exactId: target.exactId,
      expectedVersion: 1,
      requestId: "advance-before-stale-keep",
      value: "Incheon"
    });
    const beforeStale = await readFile(provenanceFile, "utf8");
    await expect(memory.keepOwnerMemory("owner", {
      exactId: target.exactId,
      expectedVersion: 1,
      requestId: "keep-stale-home-city"
    }, recordKeep(provenance))).rejects.toSatisfy((error: unknown) =>
      error instanceof UserMemoryOwnerControlError && error.code === "conflict"
    );
    expect(await readFile(provenanceFile, "utf8")).toBe(beforeStale);
  });

  it("rejects a non-actionable keep before changing memory and leaves correction usable", async () => {
    const { memory, memoryFile, provenance, provenanceFile } = await fixture();
    await memory.upsertFact("owner", "home_city", "Busan");
    await provenance.record(bp({ source: "user", value: "Busan" }));
    const target = (await memory.inspectOwnerMemory("owner"))[0]!;
    const beforeMemory = await readFile(memoryFile, "utf8");
    const beforeProvenance = await readFile(provenanceFile, "utf8");

    await expect(memory.keepOwnerMemory("owner", {
      exactId: target.exactId,
      expectedVersion: target.version,
      requestId: "keep-not-actionable"
    }, recordKeep(provenance))).rejects.toThrow("not an actionable conflict");
    expect(await readFile(memoryFile, "utf8")).toBe(beforeMemory);
    expect(await readFile(provenanceFile, "utf8")).toBe(beforeProvenance);
    await expect(memory.correctOwnerMemory("owner", {
      exactId: target.exactId,
      expectedVersion: target.version,
      requestId: "correct-after-rejected-keep",
      value: "Incheon"
    })).resolves.toMatchObject({ status: "applied" });
  });
});
