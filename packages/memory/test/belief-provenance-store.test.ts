import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FileBeliefProvenanceStore,
  MAX_BELIEF_PROVENANCE_ENTRIES,
  readBeliefProvenance,
  writeBeliefProvenance,
  type BeliefProvenance
} from "../src/belief-provenance-store.js";

function entry(over: Partial<BeliefProvenance> = {}): BeliefProvenance {
  return {
    userId: "u1",
    key: "home_city",
    kind: "fact",
    value: "Seoul",
    learnedAt: "2026-05-27T00:00:00.000Z",
    ...over
  };
}

describe("FileBeliefProvenanceStore", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "muse-prov-"));
    file = join(dir, "belief-provenance.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("records and queries newest-first, scoped to the user", async () => {
    const store = new FileBeliefProvenanceStore(file);
    await store.record(entry({ value: "Busan", learnedAt: "2026-05-01T00:00:00.000Z" }));
    await store.record(entry({ value: "Seoul", learnedAt: "2026-05-20T00:00:00.000Z" }));
    await store.record(entry({ userId: "other", value: "Paris", learnedAt: "2026-05-25T00:00:00.000Z" }));

    const mine = await store.query("u1");
    expect(mine.map((e) => e.value)).toEqual(["Seoul", "Busan"]);
    expect(mine.every((e) => e.userId === "u1")).toBe(true);
  });

  it("filters by key", async () => {
    const store = new FileBeliefProvenanceStore(file);
    await store.record(entry({ key: "home_city", value: "Seoul" }));
    await store.record(entry({ key: "role", value: "engineer" }));
    const hits = await store.query("u1", "role");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.value).toBe("engineer");
  });

  it("caps at MAX_BELIEF_PROVENANCE_ENTRIES, dropping the oldest", async () => {
    const seeded = Array.from({ length: MAX_BELIEF_PROVENANCE_ENTRIES }, (_, i) => entry({ key: `k${i}` }));
    await writeBeliefProvenance(file, seeded);
    const store = new FileBeliefProvenanceStore(file);
    await store.record(entry({ key: "newest" }));
    const all = await readBeliefProvenance(file);
    expect(all).toHaveLength(MAX_BELIEF_PROVENANCE_ENTRIES);
    expect(all.some((e) => e.key === "k0")).toBe(false);
    expect(all.some((e) => e.key === "newest")).toBe(true);
  });

  it("returns [] for a missing file", async () => {
    const store = new FileBeliefProvenanceStore(join(dir, "absent.json"));
    expect(await store.query("u1")).toEqual([]);
  });

  it("quarantines a corrupt store and reads empty", async () => {
    await writeFile(file, "{ not json", "utf8");
    expect(await readBeliefProvenance(file)).toEqual([]);
  });

  it("drops malformed entries on read", async () => {
    await writeFile(file, JSON.stringify({ entries: [entry(), { userId: "u1" }, { kind: "fact" }] }), "utf8");
    const all = await readBeliefProvenance(file);
    expect(all).toHaveLength(1);
  });
});
