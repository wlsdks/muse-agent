import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readWeaknesses, recordWeakness, selectDevFixableWeaknesses, selectRemediableWeaknesses, topicKeyFromMessage, upsertWeakness, writeWeaknesses, type WeaknessEntry } from "../src/weakness-ledger.js";

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

  it("excludes a single ask (count 1), a stale gap (>30d), and non-grounding axes", () => {
    const out = selectRemediableWeaknesses([
      e({ topic: "asked once", count: 1 }),
      e({ topic: "old", count: 9, lastSeen: "2026-01-01T00:00:00.000Z" }),
      e({ topic: "unbacked", axis: "unbacked-action", count: 5 }),
      e({ topic: "real gap", count: 2 })
    ], { nowMs });
    expect(out.map((w) => w.topic)).toEqual(["real gap"]);
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
});
