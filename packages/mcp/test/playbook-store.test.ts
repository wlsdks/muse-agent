import { rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { adjustPlaybookReward, decayStalePlaybookRewards, MAX_PLAYBOOK_ENTRIES, PLAYBOOK_DECAY_STALE_DAYS, PLAYBOOK_REWARD_MAX, PLAYBOOK_REWARD_MIN, type PlaybookEntry, readPlaybook, recordPlaybookStrategy, removePlaybookStrategy, retainPlaybookEntries, writePlaybook } from "../src/personal-playbook-store.js";

const entry = (id: string, tag?: string): PlaybookEntry => ({
  id,
  userId: "u1",
  text: "when rescheduling, default to the next business day",
  createdAt: "2026-01-01T00:00:00Z",
  ...(tag ? { tag } : {}),
});

let files: string[] = [];
const freshFile = () => {
  const file = join(tmpdir(), `muse-playbook-${files.length}-${process.pid}.json`);
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
describe("concurrent playbook mutation", () => {
  it("preserves EVERY distinct strategy recorded concurrently (no last-writer-wins loss)", async () => {
    const file = freshFile();
    await Promise.all(Array.from({ length: 20 }, (_unused, i) => recordPlaybookStrategy(file, entry(`p${i.toString()}`))));
    const all = await readPlaybook(file);
    expect(all).toHaveLength(20);
    expect(new Set(all.map((e) => e.id)).size).toBe(20);
  });

  it("applies the capacity cap to the real merged set under concurrent over-cap records", async () => {
    const file = freshFile();
    const over = MAX_PLAYBOOK_ENTRIES + 30;
    await Promise.all(Array.from({ length: over }, (_unused, i) => recordPlaybookStrategy(file, entry(`q${i.toString()}`))));
    expect(await readPlaybook(file)).toHaveLength(MAX_PLAYBOOK_ENTRIES); // not over-cap, not lost-to-stale
  });

  it("concurrent removes drop exactly the targeted strategies, leaving the rest", async () => {
    const file = freshFile();
    await Promise.all(Array.from({ length: 20 }, (_unused, i) => recordPlaybookStrategy(file, entry(`p${i.toString()}`))));
    await Promise.all(Array.from({ length: 10 }, (_unused, i) => removePlaybookStrategy(file, `p${i.toString()}`)));
    expect(await readPlaybook(file)).toHaveLength(10);
  });
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
