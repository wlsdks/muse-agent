import { describe, expect, it } from "vitest";

import { renderToolExemplarSection, selectToolExemplars } from "./tool-exemplars.js";

const BANK = [
  { prompt: "회의가 오후 2시부터 5시까지면 몇 시간이야?", tool: "time_diff" },
  { prompt: "What's today's date?", tool: "time_now" },
  { prompt: "When's the next Monday?", tool: "next_weekday_date" },
  { prompt: "벌써 12월이라니 시간 참 빠르다.", tool: null }
] as const;

describe("selectToolExemplars", () => {
  it("ranks bank entries by lexical overlap with the query", () => {
    const picked = selectToolExemplars("다음 주 월요일 며칠이야? next Monday?", BANK, 2);
    expect(picked[0]?.tool).toBe("next_weekday_date");
    expect(picked.length).toBeLessThanOrEqual(2);
  });

  it("returns nothing when no entry overlaps the query", () => {
    expect(selectToolExemplars("완전히 무관한 주제", BANK, 3)).toEqual([]);
  });

  it("is deterministic on ties — bank order wins", () => {
    const bank = [
      { prompt: "alpha beta", tool: "a" },
      { prompt: "alpha gamma", tool: "b" }
    ];
    const picked = selectToolExemplars("alpha", bank, 1);
    expect(picked[0]?.tool).toBe("a");
  });

  it("keeps a RELEVANT no-tool exemplar in the set (restraint) instead of an all-positive block", () => {
    const bank = [
      { prompt: "remind me about the dentist", tool: "set_reminder" },
      { prompt: "add dentist appointment to calendar", tool: "calendar_add" },
      { prompt: "do I have a dentist thing", tool: null } // relevant no-tool precedent
    ];
    const picked = selectToolExemplars("dentist", bank, 2);
    expect(picked).toHaveLength(2);
    expect(picked.some((e) => e.tool === null)).toBe(true); // restraint example survives
    expect(picked[0]?.tool).toBe("set_reminder"); // the strongest match is never displaced
  });

  it("does not force a no-tool exemplar when none is relevant", () => {
    const bank = [
      { prompt: "remind me dentist", tool: "set_reminder" },
      { prompt: "add dentist calendar", tool: "calendar_add" }
    ];
    const picked = selectToolExemplars("dentist", bank, 2);
    expect(picked).toHaveLength(2);
    expect(picked.every((e) => e.tool !== null)).toBe(true);
  });

  it("never sacrifices the only slot (k=1) to restraint — keeps the best match", () => {
    const bank = [
      { prompt: "remind me about the dentist", tool: "set_reminder" },
      { prompt: "do I have a dentist thing", tool: null }
    ];
    const picked = selectToolExemplars("dentist", bank, 1);
    expect(picked).toHaveLength(1);
    expect(picked[0]?.tool).toBe("set_reminder");
  });
});

describe("renderToolExemplarSection", () => {
  it("renders tool exemplars and no-tool exemplars distinctly, empty input renders nothing", () => {
    const section = renderToolExemplarSection([
      { prompt: "What's today's date?", tool: "time_now" },
      { prompt: "벌써 12월이라니 시간 참 빠르다.", tool: null }
    ]);
    expect(section).toContain("time_now");
    expect(section).toContain("no tool");
    expect(renderToolExemplarSection([])).toBe("");
  });
});
