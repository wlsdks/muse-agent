import { describe, expect, it } from "vitest";

import {
  extractDeterministicFactCandidates,
  hasCommitMarker,
  mergeFactBackstop
} from "./memory-fact-backstop.js";

describe("resolveBirthdayDate day-existence guard (drop-not-guess)", () => {
  it("keeps the raw phrase when 다음달 lacks that day — 3월에 '다음달 31일'은 4월 31일이 아니다", () => {
    const march = new Date(2026, 2, 15);
    const out = extractDeterministicFactCandidates("우리 딸 생일이 다음달 31일인데 기억해줘", { now: march });
    expect(out.daughter_birthday).toBe("다음달 31일");
  });
  it("keeps the raw phrase for 2월 30일-class impossibilities (1월 anchor)", () => {
    const jan = new Date(2026, 0, 10);
    const out = extractDeterministicFactCandidates("우리 딸 생일이 다음달 30일인데 기억해줘", { now: jan });
    expect(out.daughter_birthday).toBe("다음달 30일");
  });
  it("still resolves a valid day (1월 anchor, 다음달 28일 → 2월 28일)", () => {
    const jan = new Date(2026, 0, 10);
    const out = extractDeterministicFactCandidates("우리 딸 생일이 다음달 28일인데 기억해줘", { now: jan });
    expect(out.daughter_birthday).toBe("2월 28일");
  });
});

describe("hasCommitMarker", () => {
  it("detects 기억해", () => {
    expect(hasCommitMarker("이거 꼭 기억해줘")).toBe(true);
  });
  it("detects 까먹 (까먹을까봐)", () => {
    expect(hasCommitMarker("자꾸 까먹을까봐 걱정이예요")).toBe(true);
  });
  it("detects 잊지 마 / 잊지마", () => {
    expect(hasCommitMarker("이거 잊지 마세요")).toBe(true);
    expect(hasCommitMarker("이거 잊지마세요")).toBe(true);
  });
  it("detects English remember / don't forget", () => {
    expect(hasCommitMarker("please remember my birthday")).toBe(true);
    expect(hasCommitMarker("don't forget to call")).toBe(true);
  });
  it("is false for ordinary chat with no commit marker", () => {
    expect(hasCommitMarker("오늘 날씨가 좋네요")).toBe(false);
    expect(hasCommitMarker("")).toBe(false);
  });
});

describe("extractDeterministicFactCandidates — FIX 1 backstop", () => {
  // Anchor for every relative-date ("다음달 N일") case below: July 20, 2026 →
  // "다음달" resolves to August.
  const now = new Date(2026, 6, 20);

  it("extracts daughter_birthday from the confirmed 순자 rambling long-form message, resolved to an ABSOLUTE month (FIX N5b — a relative 'next month' string goes stale)", () => {
    const message =
      "우리 딸 생일이 다음달 5일인데 자꾸 까먹을까봐 걱정이예요. 요즘 나이가 들어서 그런지 이것저것 자꾸 잊어버리네요. " +
      "그래서 그러는데 혹시 이것 좀 꼭 기억했다가 알려줄수 있어요?";
    const candidates = extractDeterministicFactCandidates(message, { now });
    expect(candidates.daughter_birthday).toBe("8월 5일");
  });

  it("extracts the same daughter_birthday from the terse short-form phrasing, resolved absolute", () => {
    const message = "딸 생일 다음달 5일이야 기억해줘";
    const candidates = extractDeterministicFactCandidates(message, { now });
    expect(candidates.daughter_birthday).toBe("8월 5일");
  });

  it("resolves 다음달 across a December→January year boundary", () => {
    const message = "딸 생일 다음달 5일이야 기억해줘";
    const decemberNow = new Date(2026, 11, 20);
    const candidates = extractDeterministicFactCandidates(message, { now: decemberNow });
    expect(candidates.daughter_birthday).toBe("1월 5일");
  });

  it("extracts an absolute month/day birthday (아들, 8월 12일) — already absolute, passes through unchanged", () => {
    const message = "아들 생일 8월 12일인데 잊지 마세요";
    const candidates = extractDeterministicFactCandidates(message, { now });
    expect(candidates.son_birthday).toBe("8월 12일");
  });

  it("maps every supported relation noun to its English key, each resolved to the absolute month", () => {
    const cases: readonly [string, string][] = [
      ["엄마 생일 다음달 3일이야 기억해줘", "mother_birthday"],
      ["아빠 생일 다음달 3일이야 기억해줘", "father_birthday"],
      ["남편 생일 다음달 3일이야 기억해줘", "husband_birthday"],
      ["아내 생일 다음달 3일이야 기억해줘", "wife_birthday"],
      ["친구 생일 다음달 3일이야 기억해줘", "friend_birthday"]
    ];
    for (const [message, key] of cases) {
      const candidates = extractDeterministicFactCandidates(message, { now });
      expect(candidates[key]).toBe("8월 3일");
    }
  });

  it("falls back to the raw relative phrase when no `now` anchor is provided (default is wall-clock — resolution still happens, just not pinned in this test)", () => {
    const message = "딸 생일 다음달 5일이야 기억해줘";
    const candidates = extractDeterministicFactCandidates(message);
    expect(candidates.daughter_birthday).toMatch(/^\d{1,2}월 5일$/u);
  });

  it("extracts user_name from 내 이름은 X", () => {
    const message = "내 이름은 지안이야, 기억해줘";
    const candidates = extractDeterministicFactCandidates(message);
    expect(candidates.user_name).toBe("지안");
  });

  it("extracts user_name from 나 X야", () => {
    const message = "나 순자야, 잊지 마";
    const candidates = extractDeterministicFactCandidates(message);
    expect(candidates.user_name).toBe("순자");
  });

  it("extracts a 좋아해 preference", () => {
    const message = "나는 라면을 좋아해, 기억해줘";
    const candidates = extractDeterministicFactCandidates(message);
    expect(candidates.likes_item).toBe("라면");
  });

  it("extracts a 싫어해 preference", () => {
    const message = "나는 계란을 싫어해, 기억해줘";
    const candidates = extractDeterministicFactCandidates(message);
    expect(candidates.dislikes_item).toBe("계란");
  });

  it("returns {} when there is no commit marker (does not fire on ordinary chat)", () => {
    const message = "우리 딸 생일이 다음달 5일이야";
    expect(extractDeterministicFactCandidates(message)).toEqual({});
  });

  it("returns {} for an empty string", () => {
    expect(extractDeterministicFactCandidates("")).toEqual({});
  });

  it("returns {} when a commit marker is present but no known pattern matches", () => {
    const message = "그냥 오늘 있었던 일 기억해줘";
    expect(extractDeterministicFactCandidates(message)).toEqual({});
  });
});

describe("mergeFactBackstop", () => {
  it("adds a backstop key the model did not produce", () => {
    const merged = mergeFactBackstop({ pet: "dog" }, { daughter_birthday: "다음달 5일" });
    expect(merged).toEqual({ daughter_birthday: "다음달 5일", pet: "dog" });
  });

  it("never overwrites a model-extracted value for the same key", () => {
    const merged = mergeFactBackstop(
      { daughter_birthday: "다음달 5일, 성이 김씨" },
      { daughter_birthday: "다음달 5일" }
    );
    expect(merged.daughter_birthday).toBe("다음달 5일, 성이 김씨");
  });

  it("is a no-op when there are no backstop candidates", () => {
    const merged = mergeFactBackstop({ pet: "dog" }, {});
    expect(merged).toEqual({ pet: "dog" });
  });

  it("handles undefined model facts", () => {
    const merged = mergeFactBackstop(undefined, { user_name: "지안" });
    expect(merged).toEqual({ user_name: "지안" });
  });
});
