import { describe, expect, it } from "vitest";

import { createKoreanNumberTool, toKoreanNumber } from "./muse-tools-korean-number.js";

describe("toKoreanNumber (Arabic integer → Korean 만/억/조 grouping)", () => {
  it("groups by myriad (4-digit) chunks, not Western 3-digit commas", () => {
    expect(toKoreanNumber(12345678)).toBe("1234만 5678");
    expect(toKoreanNumber(123456789012)).toBe("1234억 5678만 9012");
  });

  it("drops zero chunks", () => {
    expect(toKoreanNumber(120000000)).toBe("1억 2000만");
    expect(toKoreanNumber(100000000)).toBe("1억");
    expect(toKoreanNumber(100000005)).toBe("1억 5");
    expect(toKoreanNumber(10000)).toBe("1만");
    expect(toKoreanNumber(1000000000000)).toBe("1조");
  });

  it("handles sub-만 numbers, zero, and negatives", () => {
    expect(toKoreanNumber(5678)).toBe("5678");
    expect(toKoreanNumber(0)).toBe("0");
    expect(toKoreanNumber(-50000)).toBe("-5만");
  });

  it("returns undefined for a non-integer", () => {
    expect(toKoreanNumber(123.45)).toBeUndefined();
    expect(toKoreanNumber(Number.NaN)).toBeUndefined();
  });
});

describe("createKoreanNumberTool", () => {
  it("is a read tool named korean_number that formats a number into Korean units", () => {
    const tool = createKoreanNumberTool();
    expect(tool.definition.name).toBe("korean_number");
    expect(tool.definition.risk).toBe("read");
    const out = tool.execute({ value: 12345678 }, { runId: "r", userId: "u" }) as { korean: string; value: number };
    expect(out.korean).toBe("1234만 5678");
    expect(out.value).toBe(12345678);
  });

  it("coerces a numeric string (the 12B sometimes passes the number as text)", () => {
    const out = createKoreanNumberTool().execute({ value: "120000000" }, { runId: "r", userId: "u" }) as { korean: string };
    expect(out.korean).toBe("1억 2000만");
  });

  it("returns an error (never throws) for a non-integer or non-numeric input", () => {
    const tool = createKoreanNumberTool();
    expect(tool.execute({ value: 12.5 }, { runId: "r", userId: "u" })).toHaveProperty("error");
    expect(tool.execute({ value: "not a number" }, { runId: "r", userId: "u" })).toHaveProperty("error");
  });
});
