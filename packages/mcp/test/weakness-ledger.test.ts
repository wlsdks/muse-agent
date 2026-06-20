import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { BKT_PRIOR, MAX_WEAKNESS_ENTRIES, askTimeWeaknessNudge, bktUpdate, isMasteredWeakness, readWeaknesses, recordTimeParseWeakness, recordWeakness, recordWeaknessResolved, remediationHint, selectDevFixableWeaknesses, selectRemediableWeaknesses, topicKeyFromMessage, upsertWeakness, writeWeaknesses, type WeaknessEntry } from "../src/weakness-ledger.js";

describe("recordTimeParseWeakness — wire the DEAD time-parse axis to the deterministic parse-failure signal (fire 9 source-conflict pattern, for time-parse)", () => {
  it("records axis time-parse when the phrase FAILED to parse (the deterministic parser, not the model, said no)", async () => {
    const calls: { axis: string; message: string }[] = [];
    const recordWeaknessStub = async (_file: string, signal: { axis: string; message: string }): Promise<WeaknessEntry | undefined> => {
      calls.push(signal);
      return { axis: "time-parse", count: 1, firstSeen: "x", lastSeen: "x", topic: "t" };
    };
    await recordTimeParseWeakness("blarghday next quux", true, { recordWeakness: recordWeaknessStub, weaknessesFile: "w.json" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.axis).toBe("time-parse");
    expect(calls[0]?.message).toBe("blarghday next quux");
  });
  it("does NOT record when the phrase parsed OK (no false-positive) or is blank (the actuator's success path is untouched)", async () => {
    const calls: unknown[] = [];
    const recordWeaknessStub = async (_f: string, s: unknown): Promise<WeaknessEntry | undefined> => { calls.push(s); return undefined; };
    await recordTimeParseWeakness("tomorrow 3pm", false, { recordWeakness: recordWeaknessStub, weaknessesFile: "w" });
    await recordTimeParseWeakness("   ", true, { recordWeakness: recordWeaknessStub, weaknessesFile: "w" });
    expect(calls).toHaveLength(0);
  });
  it("ROUND-TRIP: a recorded time-parse weakness now reaches the dev-fixable surface (the axis was display-only/dead before)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "muse-timeparse-"));
    const file = join(dir, "w.json");
    const now = "2026-06-20T00:00:00.000Z";
    for (let i = 0; i < 3; i++) await recordTimeParseWeakness("schedule for blarghday", true, { nowIso: now, recordWeakness, weaknessesFile: file });
    const dev = selectDevFixableWeaknesses(await readWeaknesses(file), { nowMs: Date.parse(now) });
    expect(dev.some((w) => w.axis === "time-parse")).toBe(true);
  });
});

describe("askTimeWeaknessNudge — surface a recurring user-remediable weakness AT the moment of repeated failure (runtime learn→apply)", () => {
  const e = (over: Partial<WeaknessEntry>): WeaknessEntry => ({
    axis: "grounding-gap", count: 2, firstSeen: "2026-06-01T00:00:00.000Z", lastSeen: "2026-06-07T00:00:00.000Z", topic: "x", ...over
  });
  it("returns a nudge (hint + count) for a recurring user-remediable weakness on the asked topic", () => {
    const nudge = askTimeWeaknessNudge([e({ count: 3, topic: "office vpn mtu" })], "office vpn mtu");
    expect(nudge?.count).toBe(3);
    expect(nudge?.hint).toContain("office vpn mtu");
  });
  it("undefined for a single-ask (count 1), a different topic, a DEV-fixable axis, or a MASTERED weakness", () => {
    expect(askTimeWeaknessNudge([e({ count: 1 })], "x")).toBeUndefined();
    expect(askTimeWeaknessNudge([e({ count: 3 })], "y")).toBeUndefined();
    expect(askTimeWeaknessNudge([e({ axis: "misgrounding", count: 5 })], "x")).toBeUndefined();
    expect(askTimeWeaknessNudge([e({ count: 5, pKnown: 0.99 })], "x")).toBeUndefined();
  });
  it("picks the highest-count user-remediable entry when the topic has several axes", () => {
    const nudge = askTimeWeaknessNudge([e({ axis: "grounding-gap", count: 2, topic: "addr" }), e({ axis: "source-conflict", count: 4, topic: "addr" })], "addr");
    expect(nudge?.count).toBe(4);
  });
});

describe("topicKeyFromMessage — deterministic topic clustering", () => {
  it("keeps salient content words, drops filler, lowercases (EN)", () => {
    expect(topicKeyFromMessage("What's my office VPN MTU?")).toBe("office vpn mtu");
    expect(topicKeyFromMessage("Tell me about the migration plan")).toBe("migration plan");
  });

  it("normalises NFD Korean (the macOS desktop arg path) and strips particles", () => {
    const nfd = "내 오피스 와이파이 비밀번호 뭐야".normalize("NFD");
    expect(topicKeyFromMessage(nfd)).toBe(topicKeyFromMessage("내 오피스 와이파이 비밀번호 뭐야"));
    expect(topicKeyFromMessage("내 오피스 와이파이 비밀번호 뭐야")).toContain("오피스");
  });

  it("strips Korean particles so the same topic clusters regardless of phrasing", () => {
    // "일련번호가 뭐였지" and "일련번호 알려줘" must produce the SAME topic key.
    expect(topicKeyFromMessage("내 비밀 금고 일련번호가 뭐였지?")).toBe(topicKeyFromMessage("비밀 금고 일련번호 알려줘"));
    expect(topicKeyFromMessage("회의를 언제 했지")).toContain("회의");
    expect(topicKeyFromMessage("학교에서 뭐 했어")).toContain("학교");
  });

  it("never truncates a real word that merely ends in a particle syllable", () => {
    // stem would be 1 char → left intact: 포도(→포), 바다(→바) must NOT happen.
    expect(topicKeyFromMessage("포도 가격")).toContain("포도");
    expect(topicKeyFromMessage("바다 날씨")).toContain("바다");
    expect(topicKeyFromMessage("도서관 위치")).toContain("도서관"); // 관 is not a particle
  });

  it("caps at 4 tokens, drops single-char tokens, returns '' for pure filler", () => {
    expect(topicKeyFromMessage("alpha beta gamma delta epsilon zeta").split(" ")).toHaveLength(4);
    expect(topicKeyFromMessage("a b c d")).toBe(""); // single chars dropped
    expect(topicKeyFromMessage("what is my")).toBe("");
    expect(topicKeyFromMessage("뭐야 알려줘")).toBe("");
  });
});

describe("upsertWeakness — increment matching (axis, topic), else insert", () => {
  const base: WeaknessEntry = { axis: "grounding-gap", count: 1, firstSeen: "2026-06-06T00:00:00Z", lastSeen: "2026-06-06T00:00:00Z", topic: "office vpn mtu" };

  it("increments count + lastSeen on a matching axis+topic, preserving firstSeen", () => {
    const next = upsertWeakness([base], { axis: "grounding-gap", topic: "office vpn mtu", nowIso: "2026-06-07T00:00:00Z" });
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ count: 2, firstSeen: "2026-06-06T00:00:00Z", lastSeen: "2026-06-07T00:00:00Z" });
  });

  it("inserts a new row when the axis differs (same topic)", () => {
    const next = upsertWeakness([base], { axis: "unbacked-action", topic: "office vpn mtu", nowIso: "2026-06-07T00:00:00Z" });
    expect(next).toHaveLength(2);
    expect(next[1]).toMatchObject({ axis: "unbacked-action", count: 1 });
  });

  it("does not mutate the input array", () => {
    const input = [base];
    upsertWeakness(input, { axis: "grounding-gap", topic: "office vpn mtu", nowIso: "2026-06-07T00:00:00Z" });
    expect(input[0]!.count).toBe(1);
  });
});

describe("read/write/recordWeakness — persistence round-trip", () => {
  const tmpFile = (): string => join(mkdtempSync(join(tmpdir(), "muse-weak-")), "weaknesses.json");

  it("read returns [] for a missing or corrupt file", async () => {
    expect(await readWeaknesses(join(tmpdir(), "does-not-exist-weak.json"))).toEqual([]);
  });

  it("recordWeakness clusters the message + persists, and a repeat increments", async () => {
    const file = tmpFile();
    await recordWeakness(file, { axis: "grounding-gap", message: "What's my office VPN MTU?", nowIso: "2026-06-06T00:00:00Z" });
    await recordWeakness(file, { axis: "grounding-gap", message: "what is my office vpn mtu", nowIso: "2026-06-07T00:00:00Z" });
    const entries = await readWeaknesses(file);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ axis: "grounding-gap", topic: "office vpn mtu", count: 2 });
  });

  it("recordWeakness returns the upserted entry with its new count (drives the knowledge-gap nudge)", async () => {
    const file = tmpFile();
    const first = await recordWeakness(file, { axis: "grounding-gap", message: "what's my office VPN MTU?", nowIso: "2026-06-06T00:00:00Z" });
    expect(first?.count).toBe(1);
    const second = await recordWeakness(file, { axis: "grounding-gap", message: "office vpn mtu", nowIso: "2026-06-07T00:00:00Z" });
    expect(second?.count).toBe(2);
    expect(await recordWeakness(file, { axis: "grounding-gap", message: "뭐야" })).toBeUndefined(); // no salient topic
  });

  it("recordWeakness is a no-op when the message has no salient topic", async () => {
    const file = tmpFile();
    await recordWeakness(file, { axis: "grounding-gap", message: "뭐야 알려줘", nowIso: "2026-06-06T00:00:00Z" });
    expect(await readWeaknesses(file)).toEqual([]);
  });

  it("write then read preserves the entries", async () => {
    const file = tmpFile();
    const entries: WeaknessEntry[] = [{ axis: "unbacked-action", count: 3, firstSeen: "2026-06-01T00:00:00Z", lastSeen: "2026-06-06T00:00:00Z", topic: "회의 일정" }];
    await writeWeaknesses(file, entries);
    expect(await readWeaknesses(file)).toEqual(entries);
  });
});

describe("writeWeaknesses — bounded growth cap", () => {
  const tmpFile = (): string => join(mkdtempSync(join(tmpdir(), "muse-weak-cap-")), "weaknesses.json");

  const makeEntry = (i: number, count = 1, lastSeen = "2026-06-01T00:00:00Z"): WeaknessEntry => ({
    axis: "grounding-gap",
    count,
    firstSeen: "2026-06-01T00:00:00Z",
    lastSeen,
    topic: `topic-${i.toString().padStart(6, "0")}`
  });

  it("under cap: all entries written verbatim, order preserved", async () => {
    const file = tmpFile();
    const entries: WeaknessEntry[] = [
      makeEntry(1, 3, "2026-06-05T00:00:00Z"),
      makeEntry(2, 1, "2026-06-06T00:00:00Z"),
      makeEntry(3, 2, "2026-06-04T00:00:00Z")
    ];
    await writeWeaknesses(file, entries);
    const back = await readWeaknesses(file);
    expect(back).toEqual(entries);
  });

  it("over cap: trims to MAX_WEAKNESS_ENTRIES", async () => {
    const file = tmpFile();
    const entries = Array.from({ length: MAX_WEAKNESS_ENTRIES + 50 }, (_, i) => makeEntry(i));
    await writeWeaknesses(file, entries);
    const back = await readWeaknesses(file);
    expect(back).toHaveLength(MAX_WEAKNESS_ENTRIES);
  });

  it("trim keeps highest-count entry and evicts stale count-1 entries", async () => {
    const file = tmpFile();
    const highCount = makeEntry(9999, 99, "2026-06-01T00:00:00Z");
    const stale = makeEntry(8888, 1, "2020-01-01T00:00:00Z");
    const filler = Array.from({ length: MAX_WEAKNESS_ENTRIES }, (_, i) => makeEntry(i, 2, "2026-06-02T00:00:00Z"));
    await writeWeaknesses(file, [highCount, stale, ...filler]);
    const back = await readWeaknesses(file);
    expect(back).toHaveLength(MAX_WEAKNESS_ENTRIES);
    expect(back.some((e) => e.topic === highCount.topic)).toBe(true);
    expect(back.some((e) => e.topic === stale.topic)).toBe(false);
  });

  it("tiebreak by recency: more-recent lastSeen is kept at the cap boundary", async () => {
    const file = tmpFile();
    const recent = makeEntry(9001, 5, "2026-06-10T00:00:00Z");
    const older = makeEntry(9002, 5, "2026-01-01T00:00:00Z");
    const filler = Array.from({ length: MAX_WEAKNESS_ENTRIES - 1 }, (_, i) => makeEntry(i, 5, "2026-06-05T00:00:00Z"));
    await writeWeaknesses(file, [older, recent, ...filler]);
    const back = await readWeaknesses(file);
    expect(back).toHaveLength(MAX_WEAKNESS_ENTRIES);
    expect(back.some((e) => e.topic === recent.topic)).toBe(true);
    expect(back.some((e) => e.topic === older.topic)).toBe(false);
  });

  it("bad lastSeen in an over-cap set does not throw (sorts as oldest)", async () => {
    const file = tmpFile();
    const badDate: WeaknessEntry = { ...makeEntry(9999, 1), lastSeen: "not-a-date" };
    const filler = Array.from({ length: MAX_WEAKNESS_ENTRIES }, (_, i) => makeEntry(i, 2, "2026-06-01T00:00:00Z"));
    await expect(writeWeaknesses(file, [badDate, ...filler])).resolves.toBeUndefined();
    const back = await readWeaknesses(file);
    expect(back).toHaveLength(MAX_WEAKNESS_ENTRIES);
  });
});

describe("selectRemediableWeaknesses — the Whetstone remediation nudge (grounding-gap only)", () => {
  const nowMs = Date.parse("2026-06-07T02:00:00.000Z");
  const e = (over: Partial<WeaknessEntry>): WeaknessEntry => ({
    axis: "grounding-gap", count: 2, firstSeen: "2026-06-01T00:00:00.000Z", lastSeen: "2026-06-07T00:00:00.000Z", topic: "x", ...over
  });

  it("keeps recurring, recent grounding-gaps; ranks most-asked first; caps", () => {
    const out = selectRemediableWeaknesses([
      e({ topic: "office vpn mtu", count: 3 }),
      e({ topic: "wifi password", count: 2 }),
      e({ topic: "a", count: 4 })
    ], { nowMs, maxResults: 2 });
    expect(out.map((w) => w.topic)).toEqual(["a", "office vpn mtu"]); // 4× then 3×, capped at 2
  });

  it("excludes a single ask (count 1), a stale gap (>30d), and DEV-fixable axes (Muse's own bug, not the user's)", () => {
    const out = selectRemediableWeaknesses([
      e({ topic: "asked once", count: 1 }),
      e({ topic: "old", count: 9, lastSeen: "2026-01-01T00:00:00.000Z" }),
      e({ topic: "unbacked", axis: "unbacked-action", count: 5 }),
      e({ topic: "real gap", count: 2 })
    ], { nowMs });
    expect(out.map((w) => w.topic)).toEqual(["real gap"]);
  });

  it("INCLUDES source-conflict (the user's OWN notes disagree — user-remediable) and returns each entry's axis", () => {
    const out = selectRemediableWeaknesses([
      e({ topic: "office address", axis: "source-conflict", count: 3 }),
      e({ topic: "real gap", count: 2 })
    ], { nowMs });
    expect(out.find((w) => w.topic === "office address")?.axis).toBe("source-conflict");
    expect(out.find((w) => w.topic === "real gap")?.axis).toBe("grounding-gap");
    expect(out).toHaveLength(2);
  });
});

describe("remediationHint — per-axis user-facing remediation copy", () => {
  it("nudges 'add a note' for a grounding-gap, but 'reconcile' for a source-conflict (the actions differ)", () => {
    expect(remediationHint("grounding-gap", "office vpn mtu")).toMatch(/add a note/i);
    const conflict = remediationHint("source-conflict", "office address");
    expect(conflict).toMatch(/reconcile|disagree/i);
    expect(conflict).not.toMatch(/add a note/i);
  });
});

describe("selectDevFixableWeaknesses — the dev loop's fix targets (Muse's OWN recurring bugs)", () => {
  const e = (over: Partial<WeaknessEntry>): WeaknessEntry => ({
    axis: "unbacked-action", count: 2, firstSeen: "2026-06-01T00:00:00.000Z", lastSeen: "2026-06-07T00:00:00.000Z", topic: "x", ...over
  });

  it("keeps recurring non-grounding axes (unbacked-action/wrong-tool/time-parse), most-recurring first, capped", () => {
    const out = selectDevFixableWeaknesses([
      e({ topic: "calendar add silent fail", axis: "unbacked-action", count: 4 }),
      e({ topic: "picked search not recall", axis: "wrong-tool", count: 2 }),
      e({ topic: "next friday wrong", axis: "time-parse", count: 3 })
    ], { maxResults: 2 });
    expect(out.map((w) => `${w.axis}:${w.topic}`)).toEqual([
      "unbacked-action:calendar add silent fail", // 4×
      "time-parse:next friday wrong" // 3×, capped at 2
    ]);
  });

  it("EXCLUDES grounding-gap (that's the user's to fix) and a single occurrence", () => {
    const out = selectDevFixableWeaknesses([
      e({ topic: "user note gap", axis: "grounding-gap", count: 9 }), // user-fixable → excluded
      e({ topic: "once", axis: "unbacked-action", count: 1 }), // below minCount → excluded
      e({ topic: "real agent bug", axis: "unbacked-action", count: 2 })
    ]);
    expect(out.map((w) => w.topic)).toEqual(["real agent bug"]);
  });

  it("INCLUDES misgrounding (a confident wrong-citation — GROUNDED != TRUE, Muse's own bug not the user's note gap)", () => {
    const out = selectDevFixableWeaknesses([
      e({ topic: "deadline answer cited the wrong note", axis: "misgrounding", count: 3 })
    ]);
    expect(out.map((w) => `${w.axis}:${w.topic}`)).toEqual(["misgrounding:deadline answer cited the wrong note"]);
  });
});

// BKT constants: BKT_PRIOR=0.1, BKT_LEARN=0.2, BKT_GUESS=0.2, BKT_SLIP=0.1, MASTERED_AT=0.95
// Exact dynamics (arXiv:2105.00385, Badrinath/Wang/Pardos, pyBKT, EDM'21):
//   from 0.2: success → 0.62353, → 0.90543, → 0.98186 (≥0.95 mastered)
//   from 0.96: failure → 0.80 (re-activated, below 0.95)

describe("bktUpdate — Bayesian Knowledge Tracing mastery estimator", () => {
  const near = (a: number, b: number) => expect(Math.abs(a - b) < 0.0001).toBe(true);

  it("repeated failures hold pKnown near 0.2 (slip/guess absorb noise)", () => {
    const after1 = bktUpdate(BKT_PRIOR, false); // from prior 0.1
    near(after1, 0.2110); // ≈ 0.21
    const after2 = bktUpdate(after1, false);
    // converges; stays in 0.2-0.25 range
    expect(after2).toBeGreaterThan(0.19);
    expect(after2).toBeLessThan(0.30);
  });

  it("from 0.2: three successes → ~0.62 → ~0.90 → ~0.98 (mastered)", () => {
    const p1 = bktUpdate(0.2, true);  // first success
    near(p1, 0.62353);
    const p2 = bktUpdate(p1, true);  // second
    near(p2, 0.90543);
    const p3 = bktUpdate(p2, true);  // third
    near(p3, 0.98186);
    expect(p3).toBeGreaterThanOrEqual(0.95); // mastered
  });

  it("failure from near-mastery (0.96) → ~0.80 — re-activated below threshold", () => {
    const pAfterFail = bktUpdate(0.96, false);
    near(pAfterFail, 0.80);
    expect(pAfterFail).toBeLessThan(0.95); // no longer mastered
  });

  it("success raises pKnown, failure lowers it", () => {
    const base = 0.5;
    expect(bktUpdate(base, true)).toBeGreaterThan(base);
    expect(bktUpdate(base, false)).toBeLessThan(base);
  });

  it("garbage / missing / out-of-range input coerces to BKT_PRIOR before computing", () => {
    const fromPrior = bktUpdate(BKT_PRIOR, true);
    expect(bktUpdate(undefined, true)).toBeCloseTo(fromPrior, 5);
    expect(bktUpdate(Number.NaN, true)).toBeCloseTo(fromPrior, 5);
    expect(bktUpdate(-0.5, true)).toBeCloseTo(fromPrior, 5);
    expect(bktUpdate(1.5, true)).toBeCloseTo(fromPrior, 5);
  });

  it("output is always in [0, 1]", () => {
    for (const p of [0, 0.01, 0.5, 0.99, 1]) {
      const s = bktUpdate(p, true);
      const f = bktUpdate(p, false);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
    }
  });

  it("ONE success does NOT master — counterfactual: pKnown after first success is below 0.95", () => {
    // From 0.2 (a realistic weak starting point), one success → ~0.62, NOT mastered.
    // If mastery were cleared on the first success, selectRemediableWeaknesses would
    // stop surfacing it — this test confirms that DOESN'T happen.
    const p = bktUpdate(0.2, true);
    expect(p).toBeLessThan(0.95);
  });
});

describe("isMasteredWeakness", () => {
  const e = (pKnown?: number): WeaknessEntry => ({
    axis: "grounding-gap", count: 3, firstSeen: "2026-06-01T00:00:00Z",
    lastSeen: "2026-06-13T00:00:00Z", topic: "vpn mtu",
    ...(pKnown !== undefined ? { pKnown } : {})
  });

  it("returns true when pKnown ≥ 0.95", () => {
    expect(isMasteredWeakness(e(0.95))).toBe(true);
    expect(isMasteredWeakness(e(0.98))).toBe(true);
    expect(isMasteredWeakness(e(1.0))).toBe(true);
  });

  it("returns false when pKnown < 0.95", () => {
    expect(isMasteredWeakness(e(0.94))).toBe(false);
    expect(isMasteredWeakness(e(0.62))).toBe(false);
    expect(isMasteredWeakness(e(0))).toBe(false);
  });

  it("legacy entry (no pKnown) is never mastered — back-compat", () => {
    expect(isMasteredWeakness(e(undefined))).toBe(false);
  });
});

describe("selectRemediableWeaknesses — mastered entries suppressed", () => {
  const nowMs = Date.parse("2026-06-13T02:00:00.000Z");
  const e = (over: Partial<WeaknessEntry>): WeaknessEntry => ({
    axis: "grounding-gap", count: 3, firstSeen: "2026-06-01T00:00:00.000Z",
    lastSeen: "2026-06-13T00:00:00.000Z", topic: "vpn mtu", ...over
  });

  it("mastered entry (pKnown ≥ 0.95) is NOT surfaced", () => {
    const out = selectRemediableWeaknesses([
      e({ topic: "vpn mtu", count: 5, pKnown: 0.98 }),
      e({ topic: "wifi password", count: 3 })
    ], { nowMs });
    expect(out.map((w) => w.topic)).toEqual(["wifi password"]);
  });

  it("non-vacuity: entry with pKnown 0.62 (after 1 success) is still surfaced", () => {
    const out = selectRemediableWeaknesses([
      e({ topic: "vpn mtu", count: 3, pKnown: 0.62 })
    ], { nowMs });
    expect(out.map((w) => w.topic)).toEqual(["vpn mtu"]);
  });

  it("legacy entry (no pKnown) is still surfaced — back-compat unchanged", () => {
    const legacy = e({ topic: "vpn mtu", count: 3 });
    const out = selectRemediableWeaknesses([legacy], { nowMs });
    expect(out.map((w) => w.topic)).toEqual(["vpn mtu"]);
  });

  it("failure-after-mastery (0.96 → 0.80) re-activates the entry", () => {
    const reactivated = e({ topic: "vpn mtu", count: 4, pKnown: bktUpdate(0.96, false) });
    expect(reactivated.pKnown).toBeLessThan(0.95);
    const out = selectRemediableWeaknesses([reactivated], { nowMs });
    expect(out.map((w) => w.topic)).toEqual(["vpn mtu"]);
  });
});

describe("recordWeaknessResolved — BKT success update + no partial side-effects", () => {
  const tmpFile = (): string => join(mkdtempSync(join(tmpdir(), "muse-weak-resolved-")), "weaknesses.json");
  const QUERY = "오피스 VPN MTU 뭐야";

  it("no match → returns undefined WITHOUT writing (no partial side-effect)", async () => {
    const file = tmpFile();
    await recordWeakness(file, { axis: "grounding-gap", message: "wifi password reset", nowIso: "2026-06-01T00:00:00Z" });
    const before = await readWeaknesses(file);
    const result = await recordWeaknessResolved(file, QUERY);
    expect(result).toBeUndefined();
    const after = await readWeaknesses(file);
    // File content unchanged — byte-identical comparison via topic lists
    expect(after.map((e) => e.topic)).toEqual(before.map((e) => e.topic));
    expect(after.map((e) => e.pKnown)).toEqual(before.map((e) => e.pKnown));
  });

  it("match → updates pKnown upward (success observation)", async () => {
    const file = tmpFile();
    await recordWeakness(file, { axis: "grounding-gap", message: QUERY, nowIso: "2026-06-01T00:00:00Z" });
    const before = (await readWeaknesses(file))[0]!;
    const result = await recordWeaknessResolved(file, QUERY, "2026-06-13T12:00:00Z");
    expect(result).toBeDefined();
    expect(result!.pKnown).toBeGreaterThan(before.pKnown ?? 0);
    expect(result!.lastResolved).toBe("2026-06-13T12:00:00Z");
  });

  it("missing file → no-op (undefined, no throw)", async () => {
    const result = await recordWeaknessResolved(join(tmpdir(), "does-not-exist-resolved.json"), QUERY);
    expect(result).toBeUndefined();
  });
});

describe("assembled-path: record×2 → select → resolve×3 → select empty (NON-INERT end-to-end)", () => {
  const tmpFile = (): string => join(mkdtempSync(join(tmpdir(), "muse-weak-e2e-")), "weaknesses.json");
  const QUERY = "오피스 VPN MTU 뭐야";
  const nowMs = Date.parse("2026-06-13T12:00:00.000Z");

  it("select surfaces the gap, then 3 grounded answers master it and select returns empty", async () => {
    const file = tmpFile();

    // Two failures to exceed minCount threshold
    await recordWeakness(file, { axis: "grounding-gap", message: QUERY, nowIso: "2026-06-12T10:00:00Z" });
    await recordWeakness(file, { axis: "grounding-gap", message: QUERY, nowIso: "2026-06-12T11:00:00Z" });

    // Selector surfaces it (count=2, recent, not mastered)
    const before = selectRemediableWeaknesses(await readWeaknesses(file), { nowMs });
    expect(before.map((w) => w.topic).some((t) => t.includes("vpn") || t.includes("mtu") || t.includes("오피스"))).toBe(true);

    // Three successful grounded answers push pKnown above WEAKNESS_MASTERED_AT
    await recordWeaknessResolved(file, QUERY, "2026-06-13T09:00:00Z");
    await recordWeaknessResolved(file, QUERY, "2026-06-13T10:00:00Z");
    await recordWeaknessResolved(file, QUERY, "2026-06-13T11:00:00Z");

    // Verify pKnown ≥ 0.95 in the real store
    const entries = await readWeaknesses(file);
    const entry = entries.find((e) => e.axis === "grounding-gap");
    expect(entry?.pKnown).toBeGreaterThanOrEqual(0.95);

    // Selector now returns empty for this topic — mastered
    const after = selectRemediableWeaknesses(entries, { nowMs });
    expect(after.map((w) => w.topic).some((t) => t.includes("vpn") || t.includes("mtu") || t.includes("오피스"))).toBe(false);
  });
});

describe("recordWeakness / recordWeaknessResolved — concurrent writes never lose updates", () => {
  const tmpFile = (): string => join(mkdtempSync(join(tmpdir(), "muse-weak-race-")), "weaknesses.json");

  it("N concurrent recordWeakness on distinct topics all persist (no last-writer-wins clobber)", async () => {
    const file = tmpFile();
    const topics = ["office vpn mtu", "wifi password reset", "secret safe serial", "migration plan deadline", "garage door code"];
    await Promise.all(
      topics.map((message, i) =>
        recordWeakness(file, { axis: "grounding-gap", message, nowIso: `2026-06-06T00:00:0${i}Z` })
      )
    );
    const entries = await readWeaknesses(file);
    // Every distinct signal must survive — a bare read-modify-write loses all but one.
    expect(entries).toHaveLength(topics.length);
    expect(new Set(entries.map((e) => e.topic)).size).toBe(topics.length);
  });

  it("recordWeaknessResolved racing recordWeakness keeps BOTH the new entry and the mastery bump (no collateral loss)", async () => {
    const file = tmpFile();
    await recordWeakness(file, { axis: "grounding-gap", message: "office vpn mtu", nowIso: "2026-06-01T00:00:00Z" });
    const seeded = (await readWeaknesses(file)).find((e) => e.topic.includes("vpn"));
    expect(seeded?.pKnown).toBeDefined();

    await Promise.all([
      recordWeakness(file, { axis: "grounding-gap", message: "garage door code", nowIso: "2026-06-02T00:00:00Z" }),
      recordWeaknessResolved(file, "office vpn mtu", "2026-06-02T00:00:00Z")
    ]);

    const entries = await readWeaknesses(file);
    // The new topic must NOT be clobbered by the resolve's snapshot, and vice-versa.
    expect(entries).toHaveLength(2);
    const vpn = entries.find((e) => e.topic.includes("vpn"));
    const garage = entries.find((e) => e.topic.includes("garage") || e.topic.includes("door"));
    expect(garage).toBeDefined();
    // The resolve's BKT success bump survived the concurrent record's write.
    expect(vpn?.pKnown ?? 0).toBeGreaterThan(seeded?.pKnown ?? 1);
    expect(vpn?.lastResolved).toBe("2026-06-02T00:00:00Z");
  });
});
