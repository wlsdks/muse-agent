import { describe, expect, it } from "vitest";

import { isMuseDaemonEnabled } from "../src/server.js";

describe("isMuseDaemonEnabled — the shared truthy-spelling gate for MUSE_*_POLL_ENABLED / MUSE_INBOUND_REPLY_ENABLED env flags (closes the literal `=== \"1\"` gap operator-side)", () => {
  it("returns true for every canonical truthy spelling — pre-fix the four daemon-enable flags only matched the exact string '1', so MUSE_TELEGRAM_POLL_ENABLED=true silently kept the daemon off", () => {
    for (const truthy of ["1", "true", "True", "TRUE", "yes", "YES", "Yes", "on", "ON", "On"]) {
      expect(isMuseDaemonEnabled(truthy), `expected truthy spelling ${JSON.stringify(truthy)} to enable`).toBe(true);
    }
  });

  it("returns false for every canonical falsy spelling so an explicit opt-out can't accidentally enable", () => {
    for (const falsy of ["0", "false", "False", "FALSE", "no", "NO", "off", "OFF", "  off  "]) {
      expect(isMuseDaemonEnabled(falsy), `expected falsy spelling ${JSON.stringify(falsy)} to stay off`).toBe(false);
    }
  });

  it("returns false (fail-safe) for unset, empty, whitespace-only, or garbage values — operators don't accidentally enable a daemon by setting the var to '?' or 'maybe'", () => {
    expect(isMuseDaemonEnabled(undefined)).toBe(false);
    expect(isMuseDaemonEnabled("")).toBe(false);
    expect(isMuseDaemonEnabled("   ")).toBe(false);
    expect(isMuseDaemonEnabled("maybe")).toBe(false);
    expect(isMuseDaemonEnabled("perhaps")).toBe(false);
    expect(isMuseDaemonEnabled("?")).toBe(false);
  });
});
