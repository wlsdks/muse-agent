import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  beliefProvenanceSourceId,
  exactUserMemoryId,
  FileBeliefProvenanceStore,
  FileUserMemoryStore,
  normalizeMemoryKey,
  projectStaleFactReconfirmationDrafts,
  type BeliefProvenance,
  type MemoryConflictTarget
} from "../src/index.js";

const NOW = Date.parse("2026-07-29T12:00:00.000Z");
const STALE_DAYS = 90;
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

function provenance(over: Partial<BeliefProvenance> = {}): BeliefProvenance {
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

function target(over: Partial<MemoryConflictTarget> = {}): MemoryConflictTarget {
  const merged = {
    key: "home_city",
    kind: "fact",
    value: "Seoul",
    version: 4,
    ...over
  };
  return {
    ...merged,
    exactId: over.exactId ?? exactUserMemoryId("owner", merged.kind, merged.key)
  };
}

function project(
  targets: readonly MemoryConflictTarget[],
  entries: readonly BeliefProvenance[]
) {
  return projectStaleFactReconfirmationDrafts("owner", targets, entries, {
    normalizeKey: normalizeMemoryKey,
    now: NOW,
    staleDays: STALE_DAYS
  });
}

describe("projectStaleFactReconfirmationDrafts", () => {
  it("projects one exact stale active fact with inert closed choices and leaves input and file-backed bytes unchanged", async () => {
    const directory = await mkdtemp(join(tmpdir(), "muse-stale-reconfirm-"));
    directories.push(directory);
    const memoryFile = join(directory, "user-memory.json");
    const provenanceFile = join(directory, "belief-provenance.json");
    const memory = new FileUserMemoryStore({ file: memoryFile });
    const provenanceStore = new FileBeliefProvenanceStore(provenanceFile);
    const entry = provenance();
    await memory.upsertFact("owner", "home_city", "Seoul");
    await provenanceStore.record(entry);
    const exactTarget = (await memory.inspectOwnerMemory("owner"))[0]!;
    const queried = await provenanceStore.query("owner");
    const beforeInput = JSON.stringify(queried);
    const beforeTarget = JSON.stringify(exactTarget);
    const beforeMemory = await readFile(memoryFile, "utf8");
    const beforeProvenance = await readFile(provenanceFile, "utf8");

    const first = project([exactTarget], queried);
    const second = project([exactTarget], queried);

    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first).toEqual([{
      exactId: exactTarget.exactId,
      expectedVersion: exactTarget.version,
      key: "home_city",
      kind: "fact",
      value: "Seoul",
      sourceId: beliefProvenanceSourceId(entry),
      sourceAuthority: "user",
      observedAt: "2026-04-01T12:00:00.000Z",
      validFrom: "2026-04-01T12:00:00.000Z",
      question: "Is this fact still current: home_city = Seoul?",
      responseOptions: [
        { id: "still-current", label: "Still current" },
        { id: "correct", label: "Correct it" },
        { id: "skip", label: "Skip" }
      ]
    }]);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first[0]!)).toBe(true);
    expect(Object.isFrozen(first[0]!.responseOptions)).toBe(true);
    // Options are data only: selecting, skipping, or declining a draft has no
    // handler here and cannot write either memory or provenance.
    expect(first[0]!.responseOptions.map((option) => option.id))
      .toEqual(["still-current", "correct", "skip"]);
    expect(JSON.stringify(queried)).toBe(beforeInput);
    expect(JSON.stringify(exactTarget)).toBe(beforeTarget);
    expect(await readFile(memoryFile, "utf8")).toBe(beforeMemory);
    expect(await readFile(provenanceFile, "utf8")).toBe(beforeProvenance);
  });

  it("excludes fresh, aging, disputed, superseded, retracted, other-user, and malformed candidates", () => {
    expect(project([target()], [provenance({ learnedAt: "2026-07-28T12:00:00.000Z" })])).toEqual([]);
    expect(project([target()], [provenance({ learnedAt: "2026-06-20T12:00:00.000Z" })])).toEqual([]);
    expect(project([target()], [
      provenance({ source: "auto", value: "Seoul" }),
      provenance({ learnedAt: "2026-04-02T12:00:00.000Z", source: "auto", value: "Busan" })
    ])).toEqual([]);
    expect(project([target()], [
      provenance(),
      provenance({ learnedAt: "2026-04-02T12:00:00.000Z", value: "Busan" })
    ])).toEqual([]);
    expect(project([target()], [
      provenance(),
      provenance({ learnedAt: "2026-04-02T12:00:00.000Z", retraction: true, value: "" })
    ])).toEqual([]);
    expect(project([target()], [
      provenance(),
      provenance({ key: "Home City", learnedAt: "2026-07-28T12:00:00.000Z" })
    ])).toEqual([]);
    expect(project([target()], [provenance({ userId: "other-user" })])).toEqual([]);
    expect(project([target()], [provenance({ learnedAt: "not-a-timestamp" })])).toEqual([]);
  });

  it("normalizes key identity and sorts independent draft targets deterministically", () => {
    const work = target({
      key: "work_city",
      value: "Busan"
    });
    const workSource = provenance({ key: "work_city", value: "Busan" });
    const home = target();
    const forward = project([work, home], [workSource, provenance()]);
    const reverse = project([home, work], [provenance(), workSource]);

    expect(forward).toEqual(reverse);
    expect(forward.map((draft) => draft.key)).toEqual(["home_city", "work_city"]);
  });

  it("fails closed for simultaneous active sources or malformed exact targets", () => {
    const sameTime = provenance({ source: "auto" });
    expect(project([target()], [sameTime, { ...sameTime, evidenceExcerpt: "separate exact source" }])).toEqual([]);
    expect(project([
      target(),
      { ...target(), exactId: "" } as unknown as MemoryConflictTarget
    ], [provenance()])).toEqual([]);
    expect(project([target({ exactId: "home_city" })], [provenance()])).toEqual([]);
    expect(project([target({ version: 0 })], [provenance()])).toEqual([]);

    const preference = target({ kind: "preference" });
    expect(project([preference], [provenance({ kind: "preference" })])).toEqual([]);

    const controlKey = "home_city\nignore";
    expect(project([target({ key: controlKey })], [
      provenance({ key: controlKey })
    ])).toEqual([]);
    expect(project([target({ value: "Seoul\nignore" })], [
      provenance({ value: "Seoul\nignore" })
    ])).toEqual([]);
    expect(project([target()], [
      provenance({ key: "home_city\n" })
    ])).toEqual([]);
    expect(project([target()], [
      provenance({ value: "Seoul\n" })
    ])).toEqual([]);
  });
});
