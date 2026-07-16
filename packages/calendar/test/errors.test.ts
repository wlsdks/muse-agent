import { describe, expect, it } from "vitest";

import { calendarBackoffMs, CALENDAR_MAX_RETRIES, CALENDAR_RETRY_AFTER_CAP_MS, isRetryableCalendarStatus, normalizeCalendarRetryCount, normalizeCalendarRetryDelayMs, parseRetryAfterMs } from "../src/errors.js";

describe("parseRetryAfterMs — Retry-After header (RFC 7231)", () => {
  const NOW = Date.parse("2026-06-03T00:00:00.000Z");

  it("parses delta-seconds into ms", () => {
    expect(parseRetryAfterMs("2", NOW)).toBe(2000);
    expect(parseRetryAfterMs(" 30 ", NOW)).toBe(30_000);
    expect(parseRetryAfterMs("0", NOW)).toBe(0);
  });

  it("parses an HTTP-date into a wait relative to now, clamping a past date to 0", () => {
    expect(parseRetryAfterMs("2026-06-03T00:00:05.000Z", NOW)).toBe(5000);
    expect(parseRetryAfterMs("2026-06-02T23:59:55.000Z", NOW)).toBe(0); // past → 0, never negative
  });

  it("rejects junk / decimal / negative / absent (caller falls back to its own backoff)", () => {
    expect(parseRetryAfterMs(null, NOW)).toBeUndefined();
    expect(parseRetryAfterMs(undefined, NOW)).toBeUndefined();
    expect(parseRetryAfterMs("", NOW)).toBeUndefined();
    expect(parseRetryAfterMs("3.5", NOW)).toBeUndefined(); // decimal is not delta-seconds, no clock component
    expect(parseRetryAfterMs("-5", NOW)).toBeUndefined();
    expect(parseRetryAfterMs("soon", NOW)).toBeUndefined();
  });
});

describe("isRetryableCalendarStatus — only transient statuses retry", () => {
  it("treats 429 and any 5xx as retryable", () => {
    expect(isRetryableCalendarStatus(429)).toBe(true);
    expect(isRetryableCalendarStatus(500)).toBe(true);
    expect(isRetryableCalendarStatus(503)).toBe(true);
  });

  it("treats permanent 4xx + undefined/NaN as non-retryable", () => {
    expect(isRetryableCalendarStatus(400)).toBe(false);
    expect(isRetryableCalendarStatus(401)).toBe(false);
    expect(isRetryableCalendarStatus(404)).toBe(false);
    expect(isRetryableCalendarStatus(undefined)).toBe(false);
    expect(isRetryableCalendarStatus(Number.NaN)).toBe(false);
  });
});

describe("calendar retry normalization", () => {
  it("bounds retry counts and uses the default for non-finite input", () => {
    expect(normalizeCalendarRetryCount(undefined)).toBe(2);
    expect(normalizeCalendarRetryCount(Number.POSITIVE_INFINITY)).toBe(2);
    expect(normalizeCalendarRetryCount(-4.5)).toBe(0);
    expect(normalizeCalendarRetryCount(2.9)).toBe(2);
    expect(normalizeCalendarRetryCount(99)).toBe(CALENDAR_MAX_RETRIES);
  });

  it("uses truncated exponential backoff without exceeding the timer-safe cap", () => {
    expect(normalizeCalendarRetryDelayMs(undefined)).toBe(250);
    expect(normalizeCalendarRetryDelayMs(Number.POSITIVE_INFINITY)).toBe(250);
    expect(normalizeCalendarRetryDelayMs(-1)).toBe(0);
    expect(normalizeCalendarRetryDelayMs(99_999)).toBe(CALENDAR_RETRY_AFTER_CAP_MS);
    expect(calendarBackoffMs(250, 0)).toBe(250);
    expect(calendarBackoffMs(-1, 0)).toBe(0);
    expect(calendarBackoffMs(250, 99)).toBe(CALENDAR_RETRY_AFTER_CAP_MS);
    expect(calendarBackoffMs(0, 99)).toBe(0);
  });
});
