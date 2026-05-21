import { describe, expect, it } from "vitest";

import { generateOAuthState } from "./setup-calendar.js";

describe("generateOAuthState — CSRF state token for the `muse setup calendar` Google OAuth loopback flow uses crypto.randomBytes, not Math.random, so a localhost-only attacker can't predict the state from a few observed outputs and replay-bind a victim's account", () => {
  it("returns a 32-character lowercase-hex string — 16 random bytes × 2 hex digits, giving 128 bits of entropy", () => {
    const state = generateOAuthState();
    expect(state).toMatch(/^[0-9a-f]{32}$/u);
  });

  it("emits a distinct value on every call so the per-flow nonce can't be inferred from a prior run's output", () => {
    const samples = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      samples.add(generateOAuthState());
    }
    expect(samples.size).toBe(50);
  });
});
