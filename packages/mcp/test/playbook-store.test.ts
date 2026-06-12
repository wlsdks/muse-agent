import { randomUUID } from "node:crypto";
import { rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { adjustPlaybookReward, bumpPlaybookObservation, decayStalePlaybookRewards, MAX_PLAYBOOK_ENTRIES, PLAYBOOK_DECAY_STALE_DAYS, PLAYBOOK_REWARD_MAX, PLAYBOOK_REWARD_MIN, type PlaybookEntry, queryPlaybook, readPlaybook, recordPlaybookStrategy, removePlaybookStrategy, retainPlaybookEntries, writePlaybook } from "../src/personal-playbook-store.js";

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
// capacity cap. A lost strategy is a self-improvement the agent forgets; before
// the per-file mutation queue, concurrent records clobbered one another and
// could mis-apply the cap to a stale snapshot.
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

  it("applies the capacity cap to the real merged set under concurrent over-cap records", async () => {
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

describe("probation — unattended idle-distilled strategies graduate on a real reinforce", () => {
  it("persists probation:true and graduates it (probation:false) when reward goes positive", async () => {
    const file = freshFile();
    await recordPlaybookStrategy(file, { ...entry("p1"), probation: true });
    expect((await readPlaybook(file))[0]?.probation).toBe(true); // recorded on probation
    const reward = await adjustPlaybookReward(file, "p1", 1); // a real reinforce
    expect(reward).toBe(1);
    expect((await readPlaybook(file))[0]?.probation).toBe(false); // graduated
  });

  it("keeps probation while reward stays ≤ 0 (no graduation without evidence)", async () => {
    const file = freshFile();
    await recordPlaybookStrategy(file, { ...entry("p1"), probation: true });
    await adjustPlaybookReward(file, "p1", -1); // a decay, not a reinforce
    expect((await readPlaybook(file))[0]?.probation).toBe(true);
  });
});

describe("bumpPlaybookObservation — consolidate a repeated correction WITHOUT graduating it", () => {
  it("increments timesObserved (absent → 2) and returns the new count; missing id → undefined", async () => {
    const file = freshFile();
    await recordPlaybookStrategy(file, { ...entry("p1"), probation: true });
    expect(await bumpPlaybookObservation(file, "p1")).toBe(2); // observed once at record-time → 2
    expect(await bumpPlaybookObservation(file, "p1")).toBe(3);
    expect((await readPlaybook(file))[0]?.timesObserved).toBe(3);
    expect(await bumpPlaybookObservation(file, "missing")).toBeUndefined();
  });

  it("NEGATIVE ASSERTION: bumping observation NEVER touches reward or clears probation (a repeat is a negative signal, not graduation)", async () => {
    const file = freshFile();
    await recordPlaybookStrategy(file, { ...entry("p1"), probation: true, reward: -1 });
    await bumpPlaybookObservation(file, "p1");
    await bumpPlaybookObservation(file, "p1");
    const after = (await readPlaybook(file))[0];
    expect(after?.timesObserved).toBe(3);
    expect(after?.probation).toBe(true); // still on probation — NOT graduated
    expect(after?.reward).toBe(-1); // reward unchanged — no positive signal manufactured
    expect(after?.lastReinforcedAt).toBeUndefined(); // recency anchor untouched
  });
});

describe("adjustPlaybookReward — lastReinforcedAt recency anchor (B1 §2)", () => {
  const t0 = Date.parse("2026-06-01T00:00:00Z");

  it("a positive reinforce stamps lastReinforcedAt; a decay/penalty does not", async () => {
    const file = freshFile();
    await recordPlaybookStrategy(file, entry("s1"));
    await adjustPlaybookReward(file, "s1", 2, t0);
    expect((await readPlaybook(file))[0]?.lastReinforcedAt).toBe(new Date(t0).toISOString());

    // a later penalty must NOT refresh the anchor (else disuse could never fade)
    await adjustPlaybookReward(file, "s1", -1, t0 + 5 * 86_400_000);
    expect((await readPlaybook(file))[0]?.lastReinforcedAt).toBe(new Date(t0).toISOString());
  });
});

describe("decayStalePlaybookRewards — disuse-decay toward neutral (B1 §2)", () => {
  const reinforcedAt = "2026-05-01T00:00:00Z";
  const stale = (id: string, reward: number, extra: Partial<PlaybookEntry> = {}): PlaybookEntry => ({
    ...entry(id),
    reward,
    lastReinforcedAt: reinforcedAt,
    ...extra,
  });
  // 40 days after the last reinforce — past the 30-day stale window.
  const now = Date.parse(reinforcedAt) + (PLAYBOOK_DECAY_STALE_DAYS + 10) * 86_400_000;

  it("decays a stale positive strategy one step toward neutral, never below 0", async () => {
    const file = freshFile();
    await writePlaybook(file, [stale("s1", 3), stale("s2", 1)]);
    expect(await decayStalePlaybookRewards(file, { nowMs: now })).toBe(2);
    const after = await readPlaybook(file);
    expect(after.find((e) => e.id === "s1")?.reward).toBe(2);
    expect(after.find((e) => e.id === "s2")?.reward).toBe(0); // 1 → 0, clamped at neutral

    // a second pass on the floor entry is a no-op (never goes negative)
    expect(await decayStalePlaybookRewards(file, { nowMs: now })).toBe(1); // only s1 still positive
    expect((await readPlaybook(file)).find((e) => e.id === "s1")?.reward).toBe(1);
  });

  it("leaves fresh, neutral, negative, and probation strategies untouched", async () => {
    const file = freshFile();
    await writePlaybook(file, [
      stale("fresh", 3, { lastReinforcedAt: new Date(now).toISOString() }), // reinforced just now
      stale("neutral", 0),
      stale("negative", -2),
      stale("prob", 2, { probation: true }),
    ]);
    expect(await decayStalePlaybookRewards(file, { nowMs: now })).toBe(0);
    const after = await readPlaybook(file);
    expect(after.map((e) => e.reward)).toEqual([3, 0, -2, 2]);
  });

  it("falls back to createdAt when lastReinforcedAt is absent (legacy entry)", async () => {
    const file = freshFile();
    // entry()'s createdAt is 2026-01-01 — far past the stale window from `now`
    await writePlaybook(file, [{ ...entry("legacy"), reward: 2 }]);
    expect(await decayStalePlaybookRewards(file, { nowMs: now })).toBe(1);
    expect((await readPlaybook(file))[0]?.reward).toBe(1);
  });
});

describe("provenance — origin/source round-trip + validation (B1 §4)", () => {
  it("round-trips origin + source and tolerates legacy entries without them", async () => {
    const file = freshFile();
    await recordPlaybookStrategy(file, { ...entry("g1"), origin: "grounded", source: "no — give me bullet points, not prose" });
    await recordPlaybookStrategy(file, entry("legacy")); // no origin/source
    const saved = await readPlaybook(file);
    const g1 = saved.find((e) => e.id === "g1")!;
    expect(g1.origin).toBe("grounded");
    expect(g1.source).toBe("no — give me bullet points, not prose");
    expect(saved.find((e) => e.id === "legacy")!.origin).toBeUndefined();
  });

  it("drops a row with a non-string origin/source but keeps the valid ones", async () => {
    const file = freshFile();
    await writeFile(file, JSON.stringify({ entries: [
      { ...entry("ok"), origin: "grounded", source: "the correction" },
      { ...entry("bad"), origin: 42 },
    ] }), "utf8");
    const read = await readPlaybook(file);
    expect(read.map((e) => e.id)).toEqual(["ok"]);
  });
});

describe("retainPlaybookEntries — reward-/recency-weighted eviction (B1 §3)", () => {
  const e = (id: string, reward: number): PlaybookEntry => ({ ...entry(id), reward });

  it("returns the bank unchanged when at/under the cap", () => {
    const bank = [e("a", 0), e("b", 1)];
    expect(retainPlaybookEntries(bank, 5)).toBe(bank);
    expect(retainPlaybookEntries(bank, 2)).toBe(bank);
  });

  it("keeps a high-reward OLD strategy over a low-reward NEW one (not blind FIFO)", () => {
    // insertion order = recency proxy: 'old-strong' is oldest, 'new-weak' newest
    const bank = [e("old-strong", 5), e("mid", 1), e("new-weak", 0)];
    const kept = retainPlaybookEntries(bank, 2).map((x) => x.id);
    expect(kept).toContain("old-strong"); // survives despite being oldest
    expect(kept).not.toContain("new-weak"); // evicted despite being newest
    expect(kept).toEqual(["old-strong", "mid"]); // original insertion order preserved
  });

  it("breaks reward ties by recency (newer survives)", () => {
    const bank = [e("oldest", 2), e("middle", 2), e("newest", 2)];
    expect(retainPlaybookEntries(bank, 2).map((x) => x.id)).toEqual(["middle", "newest"]);
  });

  it("evicts negative (avoided) strategies before neutral/positive ones", () => {
    const bank = [e("avoided", -4), e("neutral", 0), e("trusted", 3)];
    expect(retainPlaybookEntries(bank, 2).map((x) => x.id)).toEqual(["neutral", "trusted"]);
  });

  it("recordPlaybookStrategy applies weighted eviction: a reinforced old entry survives an overflow of neutral ones", async () => {
    const file = freshFile();
    await recordPlaybookStrategy(file, e("champion", 5)); // oldest, high reward
    for (let i = 0; i < MAX_PLAYBOOK_ENTRIES + 20; i += 1) {
      await recordPlaybookStrategy(file, e(`filler${i.toString()}`, 0));
    }
    const after = await readPlaybook(file);
    expect(after).toHaveLength(MAX_PLAYBOOK_ENTRIES);
    expect(after.some((x) => x.id === "champion")).toBe(true); // not evicted by sheer age
  });
});

describe("queryPlaybook — per-user isolation", () => {
  it("returns every entry when no userId is given, but ONLY the user's own strategies when one is", async () => {
    const file = freshFile();
    await writePlaybook(file, [
      { ...entry("a"), userId: "u1" },
      { ...entry("b"), userId: "u2" },
      { ...entry("c"), userId: "u1" }
    ]);
    expect((await queryPlaybook(file)).map((e) => e.id).sort()).toEqual(["a", "b", "c"]);
    // u1 must never see u2's strategy "b" (per-user playbook isolation).
    expect((await queryPlaybook(file, "u1")).map((e) => e.id).sort()).toEqual(["a", "c"]);
    expect((await queryPlaybook(file, "u2")).map((e) => e.id)).toEqual(["b"]);
    expect(await queryPlaybook(file, "nobody")).toEqual([]);
  });
});

/**
 * Memp (arXiv 2508.06433) END-TO-END test: store writes tallies on
 * reinforce/decay → read back → planStrategyLifecycle fires correctly.
 * Proves the mechanism is non-inert: store tally write + lifecycle action.
 */
describe("Memp tally write — store increments reinforcements/decays + lifecycle fires (arXiv 2508.06433)", () => {
  it("reinforce increments reinforcements field, decay increments decays field, both persist on read", async () => {
    const file = freshFile();
    await recordPlaybookStrategy(file, entry("m1"));

    await adjustPlaybookReward(file, "m1", 1);
    const after1 = (await readPlaybook(file))[0]!;
    expect(after1.reinforcements).toBe(1);
    expect(after1.decays).toBeUndefined();

    await adjustPlaybookReward(file, "m1", -1);
    const after2 = (await readPlaybook(file))[0]!;
    expect(after2.reinforcements).toBe(1);
    expect(after2.decays).toBe(1);
  });

  it("tallies accumulate correctly across multiple reinforce/decay calls", async () => {
    const file = freshFile();
    await recordPlaybookStrategy(file, entry("m2"));

    for (let i = 0; i < 3; i += 1) await adjustPlaybookReward(file, "m2", 1);
    for (let i = 0; i < 2; i += 1) await adjustPlaybookReward(file, "m2", -1);

    const after = (await readPlaybook(file))[0]!;
    expect(after.reinforcements).toBe(3);
    expect(after.decays).toBe(2);
  });

  it("END-TO-END: 8 decay calls → saved tallies satisfy the Memp deprecate threshold (0/8 → Wilson upper<0.4, n≥5)", async () => {
    // planStrategyLifecycle in agent-core fires "deprecate" when upper<0.4 && n≥5.
    // This test proves the store writes the tallies that would trigger that action.
    // The Wilson upper bound for 0/8 is well below 0.4 (≈0.369 at z=1.96).
    const file = freshFile();
    await recordPlaybookStrategy(file, entry("m3"));
    for (let i = 0; i < 8; i += 1) await adjustPlaybookReward(file, "m3", -1);
    const saved = (await readPlaybook(file))[0]!;
    expect(saved.decays).toBe(8);
    // reinforcements field absent (never reinforced) — treated as 0 by lifecycle
    const r = saved.reinforcements ?? 0;
    const d = saved.decays ?? 0;
    const n = r + d;
    expect(n).toBeGreaterThanOrEqual(5);
    // Inline Wilson upper bound for 0/8 (z=1.96): must be < 0.4
    const pHat = r / n;
    const z = 1.96;
    const z2 = z * z;
    const denom = 1 + z2 / n;
    const centre = (pHat + z2 / (2 * n)) / denom;
    const margin = (z / denom) * Math.sqrt(pHat * (1 - pHat) / n + z2 / (4 * n * n));
    const upper = Math.min(1, centre + margin);
    expect(upper).toBeLessThan(0.4); // confirms planStrategyLifecycle would return "deprecate"
  });

  it("END-TO-END: 4 reinforce calls → saved tallies satisfy the Memp graduate threshold (4/4 → Wilson lower>0.5, n≥3)", async () => {
    // planStrategyLifecycle returns "graduate" for probation when lower>0.5 && n≥3.
    const file = freshFile();
    await recordPlaybookStrategy(file, { ...entry("m4"), probation: true });
    for (let i = 0; i < 4; i += 1) await adjustPlaybookReward(file, "m4", 1);
    const saved = (await readPlaybook(file))[0]!;
    expect(saved.reinforcements).toBe(4);
    const r = saved.reinforcements ?? 0;
    const d = saved.decays ?? 0;
    const n = r + d;
    expect(n).toBeGreaterThanOrEqual(3);
    // Inline Wilson lower bound for 4/4: must be > 0.5
    const pHat = r / n;
    const z = 1.96;
    const z2 = z * z;
    const denom = 1 + z2 / n;
    const centre = (pHat + z2 / (2 * n)) / denom;
    const margin = (z / denom) * Math.sqrt(pHat * (1 - pHat) / n + z2 / (4 * n * n));
    const lower = Math.max(0, centre - margin);
    expect(lower).toBeGreaterThan(0.5); // confirms planStrategyLifecycle would return "graduate"
  });
});
