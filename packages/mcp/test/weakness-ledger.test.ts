import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { readWeaknesses, recordWeakness, topicKeyFromMessage, upsertWeakness, writeWeaknesses, type WeaknessEntry } from "../src/weakness-ledger.js";

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
