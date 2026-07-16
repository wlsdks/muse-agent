import { describe, expect, it } from "vitest";

import { MAX_VOICE_TIMER_DELAY_MS, normalizeVoiceTimeoutMs } from "../src/timeout-utils.js";

describe("normalizeVoiceTimeoutMs", () => {
  it("keeps only safe positive integer delays and caps Node timer overflow", () => {
    const fallback = 60_000;
    expect(normalizeVoiceTimeoutMs(25, fallback)).toBe(25);
    expect(normalizeVoiceTimeoutMs(0.5, fallback)).toBe(fallback);
    expect(normalizeVoiceTimeoutMs(0, fallback)).toBe(fallback);
    expect(normalizeVoiceTimeoutMs(Number.POSITIVE_INFINITY, fallback)).toBe(fallback);
    expect(normalizeVoiceTimeoutMs(Number.MAX_SAFE_INTEGER, fallback)).toBe(MAX_VOICE_TIMER_DELAY_MS);
  });
});
