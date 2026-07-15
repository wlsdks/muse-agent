import { describe, expect, it } from "vitest";

import { TitleMentionMatcher } from "./title-mention-matcher.js";

describe("TitleMentionMatcher — one pass finds every title a body mentions", () => {
  it("finds multiple patterns in a single scan, including overlapping ones", () => {
    const matcher = new TitleMentionMatcher(["roadmap", "road", "meeting-notes"]);
    const found = matcher.match("the roadmap and meeting-notes were updated");
    expect([...found].sort()).toEqual([0, 1, 2]);
  });

  it("matches Korean patterns (caller pre-normalizes to NFC + lowercase)", () => {
    const matcher = new TitleMentionMatcher(["로드맵정리", "주간계획"]);
    const body = "오늘 로드맵정리 문서를 봤다".normalize("NFC").toLowerCase();
    expect([...matcher.match(body)]).toEqual([0]);
  });

  it("a pattern that is a suffix of another is still reported (failure-link output inheritance)", () => {
    const matcher = new TitleMentionMatcher(["계획", "주간계획"]);
    expect([...matcher.match("이번 주간계획 봐줘").values()].sort()).toEqual([0, 1]);
  });

  it("no patterns / no matches → empty set", () => {
    expect(new TitleMentionMatcher([]).match("anything").size).toBe(0);
    expect(new TitleMentionMatcher(["absent"]).match("nothing here").size).toBe(0);
  });

  it("agrees with naive includes() on a randomized corpus (oracle check)", () => {
    const patterns = ["alpha", "beta-note", "감마문서", "delta", "입실론"];
    const bodies = [
      "we discussed alpha and 감마문서 today",
      "beta-note only",
      "nothing relevant",
      "delta 입실론 alpha all at once"
    ];
    const matcher = new TitleMentionMatcher(patterns);
    for (const body of bodies) {
      const expected = patterns.map((p, i) => body.includes(p) ? i : -1).filter((i) => i >= 0);
      expect([...matcher.match(body)].sort((a, b) => a - b)).toEqual(expected);
    }
  });
});
