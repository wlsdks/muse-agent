import { describe, expect, it } from "vitest";

import { splitCompoundQuery } from "./compound-query.js";

describe("splitCompoundQuery — RAG-Fusion compound query splitter", () => {
  it("splits KO compound with 이랑 into 2 clauses", () => {
    // "WireGuard MTU랑 집세 납부일" — 이랑 attaches to the first noun
    const clauses = splitCompoundQuery("WireGuard MTU이랑 집세 납부일 알려줘");
    expect(clauses.length).toBe(2);
    expect(clauses[0]).toContain("WireGuard");
    expect(clauses[1]).toContain("집세");
  });

  it("splits KO compound with 랑 (space-following) into 2 clauses", () => {
    // "MTU랑 집세" — 랑 directly follows first noun then space
    const clauses = splitCompoundQuery("MTU 설정값이랑 집세 납부일 알려줘");
    expect(clauses.length).toBe(2);
  });

  it("splits KO compound with 하고 into 2 clauses", () => {
    const clauses = splitCompoundQuery("노션 비밀번호 하고 기념일 날짜 알려줘");
    expect(clauses.length).toBe(2);
  });

  it("splits KO compound with 그리고 into 2 clauses", () => {
    const clauses = splitCompoundQuery("WireGuard 설정 방법 그리고 월세 날짜 알려줘");
    expect(clauses.length).toBe(2);
  });

  it("splits EN compound with ' and ' into 2 clauses", () => {
    // Both clauses must have ≥2 content tokens
    const clauses = splitCompoundQuery("WireGuard MTU setting and rent due date");
    expect(clauses.length).toBe(2);
  });

  it("splits EN compound with ' also ' into 2 clauses", () => {
    const clauses = splitCompoundQuery("VPN MTU value also rent payment date");
    expect(clauses.length).toBe(2);
  });

  it("splits on multi-? sentence boundary", () => {
    const clauses = splitCompoundQuery("VPN MTU가 뭐야? 월세 날짜는 어떻게 돼?");
    expect(clauses.length).toBeGreaterThanOrEqual(2);
  });

  it("returns [] for a simple single-topic question (no compound)", () => {
    expect(splitCompoundQuery("WireGuard MTU는 뭐야?")).toEqual([]);
  });

  it("returns [] for a greeting (too few content tokens per clause)", () => {
    // "안녕" alone is 1 token → [] even if split were attempted
    expect(splitCompoundQuery("안녕 잘 지내?")).toEqual([]);
  });

  it("returns [] for a short anaphoric turn", () => {
    expect(splitCompoundQuery("그건 뭐야?")).toEqual([]);
  });

  it("returns [] when a split clause has fewer than 2 content tokens", () => {
    // After split on ' and ', "ok" → 1 token below length≥2 threshold
    expect(splitCompoundQuery("ok and WireGuard MTU setting")).toEqual([]);
  });

  it("returns [] when the resulting clause count exceeds MAX_CLAUSES (3)", () => {
    // Four coordinated segments → [] (too many to reliably resolve)
    const q = "MTU 설정값 그리고 월세 날짜 그리고 와이파이 비밀번호 그리고 기념일 날짜";
    expect(splitCompoundQuery(q)).toEqual([]);
  });

  it("returns [] for empty string", () => {
    expect(splitCompoundQuery("")).toEqual([]);
  });

  it("is order-stable across calls with the same input", () => {
    const q = "VPN MTU 설정값이랑 월세 납부일 알려줘";
    expect(splitCompoundQuery(q)).toEqual(splitCompoundQuery(q));
  });

  it("never throws on adversarial input", () => {
    expect(() => splitCompoundQuery("!!! ??? !!!")).not.toThrow();
    expect(() => splitCompoundQuery("   ")).not.toThrow();
    expect(() => splitCompoundQuery("a and b and c and d and e and f")).not.toThrow();
  });
});
