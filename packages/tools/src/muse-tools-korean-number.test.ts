import { describe, expect, it } from "vitest";

import { createKoreanNumberTool, fromKoreanNumber, toKoreanNumber } from "./muse-tools-korean-number.js";

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

describe("fromKoreanNumber (Korean 만/억/조 expression → integer)", () => {
  it("parses myriad sections with digit chunks", () => {
    expect(fromKoreanNumber("1억 2000만")).toBe(120000000);
    expect(fromKoreanNumber("5400만")).toBe(54000000);
    expect(fromKoreanNumber("1234억 5678만 9012")).toBe(123456789012);
    expect(fromKoreanNumber("1억 5")).toBe(100000005);
  });

  it("parses 천/백/십 sub-units and compounds (천만 = 10^7)", () => {
    expect(fromKoreanNumber("1억 2천만")).toBe(120000000);
    expect(fromKoreanNumber("천만")).toBe(10000000);
    expect(fromKoreanNumber("3천5백")).toBe(3500);
    expect(fromKoreanNumber("십만")).toBe(100000);
  });

  it("ignores a trailing 원 and grouping commas/spaces", () => {
    expect(fromKoreanNumber("1억 2천만원")).toBe(120000000);
    expect(fromKoreanNumber("5,400만")).toBe(54000000);
  });

  it("returns undefined for a bare number (no unit word) or non-number text", () => {
    expect(fromKoreanNumber("12345")).toBeUndefined();
    expect(fromKoreanNumber("hello")).toBeUndefined();
    expect(fromKoreanNumber("")).toBeUndefined();
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

  it("parses a Korean expression back to digits (reverse direction), returning both forms", () => {
    const out = createKoreanNumberTool().execute({ value: "1억 2천만" }, { runId: "r", userId: "u" }) as { value: number; korean: string };
    expect(out.value).toBe(120000000);
    expect(out.korean).toBe("1억 2000만");
  });

  it("returns an error (never throws) for a non-integer or non-numeric input", () => {
    const tool = createKoreanNumberTool();
    expect(tool.execute({ value: 12.5 }, { runId: "r", userId: "u" })).toHaveProperty("error");
    expect(tool.execute({ value: "not a number" }, { runId: "r", userId: "u" })).toHaveProperty("error");
  });
});
