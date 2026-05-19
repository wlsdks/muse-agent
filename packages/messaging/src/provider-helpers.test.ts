import { describe, expect, it } from "vitest";

import { clampInboundLimit, clampOutboundText, tryParseJson } from "./provider-helpers.js";

describe("clampOutboundText", () => {
  it("returns short text unchanged", () => {
    expect(clampOutboundText("hello", 4096)).toBe("hello");
    expect(clampOutboundText("x".repeat(4096), 4096)).toBe("x".repeat(4096));
  });

  it("truncates over-limit text with a marker, never exceeding max", () => {
    const out = clampOutboundText("y".repeat(5000), 4096);
    expect(out.length).toBe(4096);
    expect(out.endsWith("… [truncated]")).toBe(true);
    expect(out.startsWith("y")).toBe(true);
  });

  it("defaults to Telegram's 4096 cap and supports a tighter platform cap", () => {
    expect(clampOutboundText("z".repeat(5000)).length).toBe(4096);
    const discord = clampOutboundText("z".repeat(3000), 2000);
    expect(discord.length).toBe(2000);
    expect(discord.endsWith("… [truncated]")).toBe(true);
  });

  it("degrades safely when max is smaller than the marker", () => {
    expect(clampOutboundText("abcdef", 3)).toBe("abc");
    expect(clampOutboundText("abcdef", 0)).toBe("");
  });

  it("never emits a lone surrogate when the cut lands inside an astral char (emoji)", () => {
    const marker = "… [truncated]";
    // Make the slice boundary fall exactly between 📋's surrogate
    // pair (U+1F4CB = 📋).
    const head = "a".repeat(4096 - marker.length - 1);
    const out = clampOutboundText(`${head}📋${"z".repeat(200)}`, 4096);
    expect(out.endsWith(marker)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(4096);
    // No unpaired high surrogate anywhere — invalid UTF-8 some chat
    // APIs 400, dropping the whole message.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(out)).toBe(false);
    // The half emoji is dropped, not mangled.
    expect(out.includes("\uD83D")).toBe(false);

    // A complete trailing emoji that fits is preserved intact.
    const fits = clampOutboundText(`${"b".repeat(10)}📋`, 4096);
    expect(fits).toBe(`${"b".repeat(10)}📋`);

    // Tight-max branch (max ≤ marker) also can't leave a half pair.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(clampOutboundText("📋x", 1))).toBe(false);
  });
});

describe("clampInboundLimit", () => {
  it("falls back to default 20 when raw is undefined / non-finite", () => {
    expect(clampInboundLimit(undefined)).toBe(20);
    expect(clampInboundLimit(Number.NaN)).toBe(20);
    expect(clampInboundLimit(Number.POSITIVE_INFINITY)).toBe(20);
  });
  it("clamps finite values into [1, max]", () => {
    expect(clampInboundLimit(0)).toBe(1);
    expect(clampInboundLimit(-5)).toBe(1);
    expect(clampInboundLimit(50)).toBe(50);
    expect(clampInboundLimit(500)).toBe(100); // default max
    expect(clampInboundLimit(500, 30)).toBe(30); // custom max
  });
  it("truncates fractional values toward zero", () => {
    expect(clampInboundLimit(5.9)).toBe(5);
    expect(clampInboundLimit(1.4)).toBe(1);
  });
});

describe("tryParseJson", () => {
  it("returns the parsed value for valid JSON", () => {
    expect(tryParseJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 });
    expect(tryParseJson<number[]>("[1,2,3]")).toEqual([1, 2, 3]);
  });
  it("returns undefined for empty body", () => {
    expect(tryParseJson("")).toBeUndefined();
  });
  it("returns undefined for invalid JSON (no throw)", () => {
    expect(tryParseJson("not json")).toBeUndefined();
    expect(tryParseJson("{unbalanced")).toBeUndefined();
  });
});
