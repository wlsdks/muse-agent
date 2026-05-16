import { describe, expect, it } from "vitest";

import { extractFollowupPromises } from "../src/followup-detector.js";

const now = new Date("2026-05-13T10:00:00.000Z");

describe("extractFollowupPromises — English relative", () => {
  it("matches `in N minutes`", () => {
    const result = extractFollowupPromises("I'll check back in 30 minutes.", { now });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      confidence: "high",
      kind: "relative-minutes",
      scheduledFor: new Date(now.getTime() + 30 * 60_000)
    });
  });

  it("matches `in N hours`", () => {
    const result = extractFollowupPromises("Ping me in 2 hours.", { now });
    expect(result[0]?.kind).toBe("relative-hours");
    expect(result[0]?.scheduledFor.getTime() - now.getTime()).toBe(2 * 3_600_000);
  });

  it("matches `in N days`", () => {
    const result = extractFollowupPromises("Let me revisit in 3 days.", { now });
    expect(result[0]?.kind).toBe("relative-days");
    expect(result[0]?.scheduledFor.getTime() - now.getTime()).toBe(3 * 86_400_000);
  });

  it("accepts the `hr`/`hrs` short form", () => {
    expect(extractFollowupPromises("in 4 hrs", { now })[0]?.kind).toBe("relative-hours");
    expect(extractFollowupPromises("in 1 hr", { now })[0]?.kind).toBe("relative-hours");
  });

  it("ignores zero / negative / non-numeric durations", () => {
    expect(extractFollowupPromises("in 0 minutes", { now })).toHaveLength(0);
    expect(extractFollowupPromises("in many minutes", { now })).toHaveLength(0);
  });
});

describe("extractFollowupPromises — English `tomorrow` slot", () => {
  it("defaults to morning when no slot is named", () => {
    const result = extractFollowupPromises("Let's revisit tomorrow.", { now });
    expect(result).toHaveLength(1);
    expect(result[0]?.confidence).toBe("low");
    expect(result[0]?.kind).toBe("tomorrow-slot");
    const expected = new Date(now);
    expected.setDate(expected.getDate() + 1);
    expected.setHours(9, 0, 0, 0);
    expect(result[0]?.scheduledFor.getTime()).toBe(expected.getTime());
  });

  it("honours `tomorrow afternoon` / `tomorrow night`", () => {
    const aft = extractFollowupPromises("I'll send the doc tomorrow afternoon.", { now })[0];
    const nt = extractFollowupPromises("Ping me tomorrow night.", { now })[0];
    expect(aft?.scheduledFor.getHours()).toBe(14);
    expect(nt?.scheduledFor.getHours()).toBe(21);
  });

  it("respects user-supplied slot overrides", () => {
    const result = extractFollowupPromises("tomorrow morning", {
      now,
      slotHours: { morning: 7 }
    });
    expect(result[0]?.scheduledFor.getHours()).toBe(7);
  });
});

describe("extractFollowupPromises — English `at HH(:MM)? (am|pm)?`", () => {
  it("schedules `at 3pm` for today when 3pm is still ahead", () => {
    const morning = new Date("2026-05-13T01:00:00.000Z"); // 10:00 KST
    const result = extractFollowupPromises("I'll send the doc at 3pm.", { now: morning });
    expect(result[0]?.scheduledFor.getHours()).toBe(15);
    expect(result[0]?.confidence).toBe("high");
  });

  it("rolls to tomorrow when the named hour has already passed", () => {
    const evening = new Date("2026-05-13T16:00:00.000Z"); // 01:00 next day KST
    const result = extractFollowupPromises("send at 6am", { now: evening });
    expect(result[0]?.scheduledFor.getTime()).toBeGreaterThan(evening.getTime());
  });

  it("converts 12am / 12pm correctly", () => {
    const noon = extractFollowupPromises("at 12pm", { now })[0];
    const midnight = extractFollowupPromises("at 12am", { now })[0];
    expect(noon?.scheduledFor.getHours()).toBe(12);
    expect(midnight?.scheduledFor.getHours()).toBe(0);
  });

  it("rejects a 12-hour-clock contradiction (`at 15pm`, `at 0am`) instead of rolling to the wrong time", () => {
    // Pre-fix `15 + 12 = 27` → setHours(27) silently rolled to ~3am
    // next day. A bare 24h hour (no meridiem) is still accepted.
    expect(extractFollowupPromises("ping me at 15pm", { now })
      .filter((p) => p.kind === "today-at")).toHaveLength(0);
    expect(extractFollowupPromises("at 0am", { now })
      .filter((p) => p.kind === "today-at")).toHaveLength(0);
    expect(extractFollowupPromises("at 13pm", { now })
      .filter((p) => p.kind === "today-at")).toHaveLength(0);
    const bare24 = extractFollowupPromises("at 20", { now }).find((p) => p.kind === "today-at");
    expect(bare24?.scheduledFor.getHours()).toBe(20);
  });
});

describe("extractFollowupPromises — Korean relative", () => {
  it("matches `N분 뒤`", () => {
    const result = extractFollowupPromises("30분 뒤에 다시 확인할게요.", { now });
    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe("korean-relative-minutes");
    expect(result[0]?.scheduledFor.getTime() - now.getTime()).toBe(30 * 60_000);
  });

  it("matches `N시간 후`", () => {
    const result = extractFollowupPromises("2시간 후에 보고 드리겠습니다.", { now });
    expect(result[0]?.kind).toBe("korean-relative-hours");
    expect(result[0]?.scheduledFor.getTime() - now.getTime()).toBe(2 * 3_600_000);
  });

  it("matches `내일 아침` with morning slot", () => {
    const result = extractFollowupPromises("내일 아침에 다시 봐 드릴게요.", { now });
    expect(result[0]?.kind).toBe("korean-tomorrow-slot");
    expect(result[0]?.scheduledFor.getHours()).toBe(9);
  });

  it("matches `오늘 3시에`", () => {
    const morning = new Date("2026-05-13T00:00:00.000Z"); // 09:00 KST
    const result = extractFollowupPromises("오늘 15시에 확인합니다.", { now: morning });
    const hit = result.find((p) => p.kind === "korean-today-at");
    expect(hit).toBeDefined();
    expect(hit?.scheduledFor.getHours()).toBe(15);
  });

  it("does NOT match `시간` (hour-unit) as `시 + 간` for the today-at pattern", () => {
    // "5시간 뒤" must classify as korean-relative-hours, not korean-today-at.
    const result = extractFollowupPromises("5시간 뒤에 회신할게요.", { now });
    expect(result.every((p) => p.kind !== "korean-today-at")).toBe(true);
    expect(result.some((p) => p.kind === "korean-relative-hours")).toBe(true);
  });
});

describe("extractFollowupPromises — multi-promise + dedupe", () => {
  it("emits one entry per distinct resolved minute even when paraphrased", () => {
    const result = extractFollowupPromises(
      "Ping me in 30 minutes — actually, in 30 min works too.",
      { now }
    );
    expect(result).toHaveLength(1);
  });

  it("emits independent entries for distinct times in one turn", () => {
    const result = extractFollowupPromises(
      "I'll check in 1 hour, and follow up tomorrow morning.",
      { now }
    );
    const kinds = result.map((r) => r.kind).sort();
    expect(kinds).toEqual(["relative-hours", "tomorrow-slot"]);
  });

  it("returns empty for non-followup text", () => {
    expect(extractFollowupPromises("I'll think about it.", { now })).toHaveLength(0);
    expect(extractFollowupPromises("Sounds good!", { now })).toHaveLength(0);
    expect(extractFollowupPromises("", { now })).toHaveLength(0);
  });
});
