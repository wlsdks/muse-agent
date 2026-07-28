import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileBeliefProvenanceStore,
  projectTemporalBeliefProvenance,
  type BeliefProvenance
} from "../src/index.js";

function provenance(over: Partial<BeliefProvenance> = {}): BeliefProvenance {
  return {
    key: "home_city",
    kind: "fact",
    learnedAt: "2026-07-28T10:00:00.000Z",
    source: "auto",
    userId: "owner",
    value: "Seoul",
    ...over
  };
}

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { force: true, recursive: true })
  ));
});

describe("projectTemporalBeliefProvenance", () => {
  it("projects assertion history into a current active interval without confidence aggregation", () => {
    const result = projectTemporalBeliefProvenance("owner", [
      provenance({ learnedAt: "2026-07-28T10:00:00.000Z", value: "Seoul" }),
      provenance({ learnedAt: "2026-07-29T10:00:00.000Z", source: "user", value: "Busan" })
    ], { normalizeKey: (key) => key.toUpperCase() });

    expect(result).toEqual([
      expect.objectContaining({
        invalidatedAt: "2026-07-29T10:00:00.000Z",
        key: "HOME_CITY",
        sourceAuthority: "auto",
        temporalState: "historical",
        validFrom: "2026-07-28T10:00:00.000Z",
        value: "Seoul"
      }),
      expect.objectContaining({
        key: "HOME_CITY",
        observedAt: "2026-07-29T10:00:00.000Z",
        sourceAuthority: "user",
        temporalState: "active",
        value: "Busan"
      })
    ]);
    expect(result[0]).not.toHaveProperty("confidence");
  });

  it("marks a latest retraction invalidated, and makes it historical after a later re-set", () => {
    const retraction = provenance({ learnedAt: "2026-07-29T10:00:00.000Z", retraction: true, value: "" });
    expect(projectTemporalBeliefProvenance("owner", [provenance(), retraction]))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ event: "retraction", temporalState: "invalidated" })
      ]));

    const result = projectTemporalBeliefProvenance("owner", [
      provenance(),
      retraction,
      provenance({ learnedAt: "2026-07-30T10:00:00.000Z", source: "user", value: "Incheon" })
    ]);
    const projectedRetraction = result.find((event) => event.event === "retraction");
    expect(projectedRetraction).toEqual(expect.objectContaining({
      invalidatedAt: "2026-07-30T10:00:00.000Z",
      temporalState: "historical"
    }));
    expect(projectedRetraction).not.toHaveProperty("value");
    expect(result.at(-1)).toEqual(expect.objectContaining({ temporalState: "active", value: "Incheon" }));
  });

  it("keeps equal-time conflicting assertions simultaneous and deterministic under input permutation", () => {
    const left = provenance({ learnedAt: "2026-07-29T10:00:00.000Z", value: "Seoul" });
    const right = provenance({ learnedAt: "2026-07-29T10:00:00.000Z", value: "Busan" });
    const first = projectTemporalBeliefProvenance("owner", [left, right]);
    const second = projectTemporalBeliefProvenance("owner", [right, left]);

    expect(first).toEqual(second);
    expect(first).toHaveLength(2);
    expect(first.every((event) => event.temporalState === "active" && event.invalidatedAt === undefined)).toBe(true);
  });

  it("scopes to one user, never exposes excerpts, and fails closed for malformed temporal input", () => {
    const result = projectTemporalBeliefProvenance("owner", [
      provenance({ evidenceExcerpt: "private source text" }),
      provenance({ evidenceExcerpt: "other private text", key: "other", userId: "other-user", value: "secret" })
    ]);
    expect(result).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain("private");
    expect(JSON.stringify(result)).not.toContain("other-user");

    const malformed = provenance({ learnedAt: "not-a-timestamp" }) as unknown as BeliefProvenance;
    expect(projectTemporalBeliefProvenance("owner", [provenance(), malformed])).toEqual([]);

    const malformedOther = {
      ...provenance({ userId: "other-user" }),
      learnedAt: "not-a-timestamp"
    } as unknown as BeliefProvenance;
    expect(projectTemporalBeliefProvenance("owner", [provenance(), malformedOther]))
      .toEqual(projectTemporalBeliefProvenance("owner", [provenance()]));

    const ambiguousOwner = {
      ...provenance(),
      userId: 42
    } as unknown as BeliefProvenance;
    expect(projectTemporalBeliefProvenance("owner", [provenance(), ambiguousOwner])).toEqual([]);
  });

  it("does not mutate input objects or stored provenance bytes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "muse-temporal-projection-"));
    directories.push(directory);
    const file = join(directory, "belief-provenance.json");
    const store = new FileBeliefProvenanceStore(file);
    const entries = [
      provenance(),
      provenance({ learnedAt: "2026-07-29T10:00:00.000Z", value: "Busan" })
    ];
    await store.recordMany(entries);
    const before = await readFile(file, "utf8");
    const queried = await store.query("owner");
    const inputBytes = JSON.stringify(queried);
    const firstInput = queried[0];

    projectTemporalBeliefProvenance("owner", queried);

    expect(JSON.stringify(queried)).toBe(inputBytes);
    expect(queried[0]).toBe(firstInput);
    expect(await readFile(file, "utf8")).toBe(before);
  });
});
