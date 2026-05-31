import { randomUUID } from "node:crypto";
import { rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { adjustPlaybookReward, MAX_PLAYBOOK_ENTRIES, PLAYBOOK_REWARD_MAX, PLAYBOOK_REWARD_MIN, type PlaybookEntry, readPlaybook, recordPlaybookStrategy, removePlaybookStrategy, writePlaybook } from "../src/personal-playbook-store.js";

const entry = (id: string, tag?: string): PlaybookEntry => ({
  id,
  userId: "u1",
  text: "when rescheduling, default to the next business day",
  createdAt: "2026-01-01T00:00:00Z",
  ...(tag ? { tag } : {}),
});

let files: string[] = [];
// Globally-unique per call. The previous `files.length`-based name reset to
// index 0 every afterEach, so a test that left async writes running past its
// timeout (the concurrent over-cap case) re-created the SAME path the NEXT
// test then used — leaking ~90 stale entries into it. A UUID can't collide
// across tests regardless of timeout/teardown ordering.
const freshFile = () => {
  const file = join(tmpdir(), `muse-playbook-${randomUUID()}.json`);
  files.push(file);
  return file;
};
afterEach(async () => {
  await Promise.all(files.map((f) => rm(f, { force: true })));
  files = [];
});

describe("readPlaybook / writePlaybook", () => {
  it("round-trips entries (including the optional tag) with 0600 perms", async () => {
    const file = freshFile();
    await writePlaybook(file, [entry("a", "email"), entry("b")]);
    expect((await readPlaybook(file)).map((e) => ({ id: e.id, tag: e.tag }))).toEqual([
      { id: "a", tag: "email" },
      { id: "b", tag: undefined },
    ]);
    expect((await stat(file)).mode.toString(8).slice(-3)).toBe("600");
  });

  it("returns [] for a missing file and for a corrupt one", async () => {
    const missing = freshFile();
    expect(await readPlaybook(missing)).toEqual([]);
    const corrupt = freshFile();
    await writeFile(corrupt, "not json", { mode: 0o600 });
    expect(await readPlaybook(corrupt)).toEqual([]);
  });

  it("writes an empty list and reads it back empty", async () => {
    const file = freshFile();
    await writePlaybook(file, []);
    expect(await readPlaybook(file)).toEqual([]);
  });
});

describe("removePlaybookStrategy", () => {
  it("removes a matching id and reports true", async () => {
    const file = freshFile();
    await writePlaybook(file, [entry("a"), entry("b")]);
    await expect(removePlaybookStrategy(file, "a")).resolves.toBe(true);
    expect((await readPlaybook(file)).map((e) => e.id)).toEqual(["b"]);
  });

  it("reports false and changes nothing when the id is absent", async () => {
    const file = freshFile();
    await writePlaybook(file, [entry("a")]);
    await expect(removePlaybookStrategy(file, "missing")).resolves.toBe(false);
    expect((await readPlaybook(file)).map((e) => e.id)).toEqual(["a"]);
  });

  it("reports false on an empty / missing store", async () => {
    const file = freshFile();
    await expect(removePlaybookStrategy(file, "anything")).resolves.toBe(false);
  });
});

// Concurrency (shared atomic-file helper migration): recordPlaybookStrategy /
// removePlaybookStrategy are read-modify-write, and the record path applies a
// FIFO cap. A lost strategy is a self-improvement the agent forgets; before the
// per-file mutation queue, concurrent records clobbered one another and could
// mis-apply the cap to a stale snapshot.
// These drive MANY serialized real-fs read-modify-write cycles through
// withFileMutationQueue (the over-cap case is 130 full-file rewrites). The
// assertions are deterministic — the queue serializes the RMW — but the
// wall-clock balloons under a saturated CPU (the full parallel `pnpm check`),
// where the default 5s test timeout was being hit and surfaced as a failure.
// Give them explicit headroom so contention can't kill a correct test.
const CONCURRENT_FS_TIMEOUT_MS = 30_000;

describe("concurrent playbook mutation", () => {
  it("preserves EVERY distinct strategy recorded concurrently (no last-writer-wins loss)", async () => {
    const file = freshFile();
    await Promise.all(Array.from({ length: 20 }, (_unused, i) => recordPlaybookStrategy(file, entry(`p${i.toString()}`))));
    const all = await readPlaybook(file);
    expect(all).toHaveLength(20);
    expect(new Set(all.map((e) => e.id)).size).toBe(20);
  }, CONCURRENT_FS_TIMEOUT_MS);

  it("applies the FIFO cap to the real merged set under concurrent over-cap records", async () => {
    const file = freshFile();
    const over = MAX_PLAYBOOK_ENTRIES + 30;
    await Promise.all(Array.from({ length: over }, (_unused, i) => recordPlaybookStrategy(file, entry(`q${i.toString()}`))));
    expect(await readPlaybook(file)).toHaveLength(MAX_PLAYBOOK_ENTRIES); // not over-cap, not lost-to-stale
  }, CONCURRENT_FS_TIMEOUT_MS);

  it("concurrent removes drop exactly the targeted strategies, leaving the rest", async () => {
    const file = freshFile();
    await Promise.all(Array.from({ length: 20 }, (_unused, i) => recordPlaybookStrategy(file, entry(`p${i.toString()}`))));
    await Promise.all(Array.from({ length: 10 }, (_unused, i) => removePlaybookStrategy(file, `p${i.toString()}`)));
    expect(await readPlaybook(file)).toHaveLength(10);
  }, CONCURRENT_FS_TIMEOUT_MS);
});

describe("adjustPlaybookReward — the RL reinforce/decay update", () => {
  it("accumulates from an absent (0) reward and persists; other entries untouched", async () => {
    const file = freshFile();
    await writePlaybook(file, [entry("a"), entry("b")]);
    expect(await adjustPlaybookReward(file, "a", 1)).toBe(1); // absent → 0 → +1
    expect(await adjustPlaybookReward(file, "a", 1)).toBe(2);
    expect(await adjustPlaybookReward(file, "a", -1)).toBe(1);
    const saved = await readPlaybook(file);
    expect(saved.find((e) => e.id === "a")!.reward).toBe(1);
    expect(saved.find((e) => e.id === "b")!.reward).toBeUndefined(); // never adjusted
    expect(saved.map((e) => e.id)).toEqual(["a", "b"]); // order preserved (recency proxy)
  });

  it("clamps to [MIN, MAX] so one streak can't run away", async () => {
    const file = freshFile();
    await writePlaybook(file, [entry("a")]);
    expect(await adjustPlaybookReward(file, "a", 999)).toBe(PLAYBOOK_REWARD_MAX);
    expect(await adjustPlaybookReward(file, "a", -999)).toBe(PLAYBOOK_REWARD_MIN);
  });

  it("returns undefined for an unknown id and for a non-finite delta (no write)", async () => {
    const file = freshFile();
    await writePlaybook(file, [{ ...entry("a"), reward: 2 }]);
    expect(await adjustPlaybookReward(file, "missing", -1)).toBeUndefined();
    expect(await adjustPlaybookReward(file, "a", Number.NaN)).toBeUndefined();
    expect((await readPlaybook(file)).find((e) => e.id === "a")!.reward).toBe(2); // unchanged
  });

  it("tolerates a numeric reward on read but quarantines a non-numeric one", async () => {
    const file = freshFile();
    await writeFile(file, JSON.stringify({ entries: [{ ...entry("ok"), reward: -3 }, { ...entry("bad"), reward: "high" }] }), "utf8");
    const read = await readPlaybook(file);
    expect(read).toHaveLength(1); // the bad-reward row is dropped, the good one survives
    expect(read[0]!.id).toBe("ok");
    expect(read[0]!.reward).toBe(-3);
  });
});
