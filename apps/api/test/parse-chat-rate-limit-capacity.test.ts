import { describe, expect, it } from "vitest";

import { isChatRateLimitDisabled, parseChatRateLimitCapacity } from "../src/server-routes.js";

describe("parseChatRateLimitCapacity — strict-parses MUSE_RATE_LIMIT_CHAT_PER_MINUTE", () => {
  it("returns the fallback when the env value is undefined or non-string", () => {
    expect(parseChatRateLimitCapacity(undefined)).toBe(60);
  });

  it("accepts a clean positive integer (trimmed)", () => {
    expect(parseChatRateLimitCapacity("30")).toBe(30);
    expect(parseChatRateLimitCapacity(" 120 ")).toBe(120);
  });

  it("rejects a lenient-prefix typo / unit-slip / decimal / scientific so the rate limit can't be silently mis-sized", () => {
    for (const bad of ["60x", "30s", "1e3", "5.9", "12abc", "1_000", "-3", "0", " ", "NaN", "Infinity", ""]) {
      expect(parseChatRateLimitCapacity(bad), `"${bad}" must fall through to fallback`).toBe(60);
    }
  });

  it("honours an explicit fallback when no env value parses", () => {
    expect(parseChatRateLimitCapacity(undefined, 120)).toBe(120);
    expect(parseChatRateLimitCapacity("bogus", 120)).toBe(120);
    expect(parseChatRateLimitCapacity("0", 120)).toBe(120);
    expect(parseChatRateLimitCapacity("-7", 120)).toBe(120);
  });
});

describe("isChatRateLimitDisabled — MUSE_RATE_LIMIT_CHAT_DISABLED accepts every standard truthy spelling", () => {
  it("defaults to false (NOT disabled = rate limit active) when the env value is unset", () => {
    expect(isChatRateLimitDisabled(undefined)).toBe(false);
  });

  it("recognises every standard truthy spelling (true / 1 / yes / on, case-insensitive, trimmed) as 'disabled'", () => {
    for (const value of ["true", "True", "TRUE", "1", "yes", "YES", "on", "On", "  true  "]) {
      expect(
        isChatRateLimitDisabled(value),
        `MUSE_RATE_LIMIT_CHAT_DISABLED="${value}" must disable the rate limiter`
      ).toBe(true);
    }
  });

  it("recognises every standard falsy spelling as 'not disabled' (rate limit stays active)", () => {
    for (const value of ["false", "False", "FALSE", "0", "no", "NO", "off", "Off"]) {
      expect(
        isChatRateLimitDisabled(value),
        `MUSE_RATE_LIMIT_CHAT_DISABLED="${value}" must keep the rate limiter active`
      ).toBe(false);
    }
  });

  it("returns false (rate limit stays active) for an unrecognised typo — a security-adjacent flag fails safe, not silently disabled", () => {
    // The fail-safe direction on a "disable rate limit" flag is to
    // KEEP the limiter on when the env value is gibberish. A user
    // who typed `MUSE_RATE_LIMIT_CHAT_DISABLED=truue` (transposed)
    // gets a working limiter, not a silently-disabled one.
    for (const value of ["truue", "enabled", "disabled", "y", "n", "  ", "xyz", "2"]) {
      expect(
        isChatRateLimitDisabled(value),
        `MUSE_RATE_LIMIT_CHAT_DISABLED="${value}" (typo) must NOT disable the limiter`
      ).toBe(false);
    }
  });
});
