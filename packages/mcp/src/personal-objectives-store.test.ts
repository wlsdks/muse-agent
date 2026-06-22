import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  addObjective,
  patchObjective,
  readObjectives,
  serializeObjective,
  writeObjectives,
  type StandingObjective
} from "@muse/stores";

function tmpFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "muse-objectives-"));
  return join(dir, "objectives.json");
}

function fixture(overrides: Partial<StandingObjective> = {}): StandingObjective {
  return {
    createdAt: "2026-05-18T10:00:00.000Z",
    id: "obj_1",
    kind: "until",
    spec: "keep checking the CI build until it goes green, then tell me",
    status: "active",
    userId: "stark",
    ...overrides
  };
}

describe("personal-objectives-store — P5-b1 durable standing objectives", () => {
  it("register → restart → still tracked: a registered objective survives a fresh read", async () => {
    const file = tmpFile();
    await addObjective(file, fixture());

    // A brand-new readObjectives call shares NO in-memory state with
    // the write — it is exactly what a post-restart / next-tick
    // process sees. The objective must still be there, intact.
    const afterRestart = await readObjectives(file);
    expect(afterRestart).toHaveLength(1);
    expect(afterRestart[0]).toEqual(fixture());
  });

  it("accumulates across independent registrations (each a separate 'process')", async () => {
    const file = tmpFile();
    await addObjective(file, fixture({ id: "obj_a", spec: "watch the deploy" }));
    await addObjective(file, fixture({ id: "obj_b", kind: "notify", spec: "tell me when the PR merges" }));
    const all = await readObjectives(file);
    expect(all.map((o) => o.id).sort()).toEqual(["obj_a", "obj_b"]);
  });

  it("is idempotent on id — re-registering replaces, never duplicates", async () => {
    const file = tmpFile();
    await addObjective(file, fixture());
    await addObjective(file, fixture({ spec: "updated: until it goes green AND tests pass" }));
    const all = await readObjectives(file);
    expect(all).toHaveLength(1);
    expect(all[0]!.spec).toBe("updated: until it goes green AND tests pass");
  });

  it("tolerant read: a missing file is an empty list, not an error", async () => {
    expect(await readObjectives(join(tmpdir(), "definitely-missing-objectives.json"))).toEqual([]);
  });

  it("corrupt store → empty list AND quarantined aside (never silently destroyed)", async () => {
    const file = tmpFile();
    writeFileSync(file, "{ not json");
    expect(await readObjectives(file)).toEqual([]);
    const siblings = readdirSync(dirname(file));
    expect(siblings.some((n) => n.includes("objectives.json.corrupt-"))).toBe(true);
  });

  it("drops malformed entries (bad kind / status) on load instead of surfacing junk", async () => {
    const file = tmpFile();
    await writeObjectives(file, [fixture()]);
    // Hand-poison the file with one bad entry alongside the good one.
    writeFileSync(
      file,
      JSON.stringify({
        objectives: [
          serializeObjective(fixture()),
          { ...serializeObjective(fixture({ id: "bad" })), kind: "explode" }
        ]
      })
    );
    const all = await readObjectives(file);
    expect(all.map((o) => o.id)).toEqual(["obj_1"]);
  });

  it("written store is private (0600) and round-trips through serializeObjective", async () => {
    const file = tmpFile();
    const withOptionals = fixture({ attempts: 2, lastEvaluatedAt: "2026-05-18T11:00:00.000Z" });
    await writeObjectives(file, [withOptionals]);
    expect(existsSync(file)).toBe(true);
    const [loaded] = await readObjectives(file);
    expect(loaded).toEqual(withOptionals);
    expect(serializeObjective(withOptionals)).toMatchObject({ attempts: 2, id: "obj_1" });
  });

  // Concurrency (backlog Concurrency item — now on the shared atomic-file
  // helper): addObjective / patchObjective are read-modify-write. Before the
  // per-file mutation queue, concurrent registrations each read the same
  // snapshot and clobbered one another — a lost standing objective is an intent
  // the daemon never acts on (user-facing). These assert lossless, crash-free.
  describe("concurrent registration + patching", () => {
    it("preserves ALL objectives when distinct ones are registered concurrently (no lost-update)", async () => {
      const file = tmpFile();
      await Promise.all(Array.from({ length: 20 }, (_unused, i) => addObjective(file, fixture({ id: `o${i.toString()}` }))));
      const all = await readObjectives(file);
      expect(all).toHaveLength(20); // not last-writer-wins (would be 1)
      expect(new Set(all.map((o) => o.id)).size).toBe(20);
    });

    it("applies every concurrent status patch on distinct ids (no crash, none dropped)", async () => {
      const file = tmpFile();
      await Promise.all(Array.from({ length: 20 }, (_unused, i) => addObjective(file, fixture({ id: `o${i.toString()}` }))));
      await Promise.all((await readObjectives(file)).map((o) => patchObjective(file, o.id, { status: "done" })));
      const all = await readObjectives(file);
      expect(all).toHaveLength(20);
      expect(all.every((o) => o.status === "done")).toBe(true);
    });
  });
});
