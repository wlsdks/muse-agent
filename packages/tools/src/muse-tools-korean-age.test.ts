import { describe, expect, it } from "vitest";

import { createKoreanAgeTool, koreanAge } from "./muse-tools-korean-age.js";

const NOW = () => new Date(2026, 5, 14); // 2026-06-14 (local)

describe("koreanAge (만 나이 / 세는나이)", () => {
  it("subtracts a year when the birthday hasn't occurred yet this year (만 나이)", () => {
    expect(koreanAge("1990-03-15", NOW())).toEqual({ international: 36, counting: 37 }); // birthday passed
    expect(koreanAge("1990-12-25", NOW())).toEqual({ international: 35, counting: 37 }); // birthday not yet
  });

  it("counts the birthday on the day itself, and handles a same-year birth", () => {
    expect(koreanAge("1990-06-14", NOW())).toEqual({ international: 36, counting: 37 }); // birthday today
    expect(koreanAge("2000-06-15", NOW())).toEqual({ international: 25, counting: 27 }); // birthday tomorrow → not yet
    expect(koreanAge("2026-06-14", NOW())).toEqual({ international: 0, counting: 1 }); // born today
  });

  it("returns undefined for a future birthdate or an impossible date", () => {
    expect(koreanAge("2027-01-01", NOW())).toBeUndefined();
    expect(koreanAge("1990-02-30", NOW())).toBeUndefined(); // Feb 30 doesn't exist
    expect(koreanAge("not-a-date", NOW())).toBeUndefined();
  });
});

describe("createKoreanAgeTool", () => {
  it("is a read tool named korean_age returning 만 나이 + 세는나이", () => {
    const tool = createKoreanAgeTool(NOW);
    expect(tool.definition.name).toBe("korean_age");
    expect(tool.definition.risk).toBe("read");
    const out = tool.execute({ birthdate: "1990-03-15" }, { runId: "r", userId: "u" }) as { internationalAge: number; countingAge: number };
    expect(out.internationalAge).toBe(36);
    expect(out.countingAge).toBe(37);
  });

  it("returns an error (never throws) for a bad birthdate", () => {
    const tool = createKoreanAgeTool(NOW);
    expect(tool.execute({ birthdate: "2027-01-01" }, { runId: "r", userId: "u" })).toHaveProperty("error");
    expect(tool.execute({ birthdate: "1990-02-30" }, { runId: "r", userId: "u" })).toHaveProperty("error");
  });
});
