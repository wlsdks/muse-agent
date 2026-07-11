import { describe, expect, it } from "vitest";

import { resolveBrowserMaxActions } from "./browser-action-budget-config.js";

describe("resolveBrowserMaxActions", () => {
  it("defaults to 30 when MUSE_BROWSER_MAX_ACTIONS is absent", () => {
    expect(resolveBrowserMaxActions({})).toBe(30);
  });

  it("uses a genuine positive integer override", () => {
    expect(resolveBrowserMaxActions({ MUSE_BROWSER_MAX_ACTIONS: "10" })).toBe(10);
    expect(resolveBrowserMaxActions({ MUSE_BROWSER_MAX_ACTIONS: "1" })).toBe(1);
  });

  it("falls back to the default for a blank value", () => {
    expect(resolveBrowserMaxActions({ MUSE_BROWSER_MAX_ACTIONS: "  " })).toBe(30);
  });

  it("floors 0 to the default instead of forbidding all browser actions", () => {
    expect(resolveBrowserMaxActions({ MUSE_BROWSER_MAX_ACTIONS: "0" })).toBe(30);
  });

  it("falls back to the default for a negative value", () => {
    expect(resolveBrowserMaxActions({ MUSE_BROWSER_MAX_ACTIONS: "-5" })).toBe(30);
  });

  it("falls back to the default for a non-integer value", () => {
    expect(resolveBrowserMaxActions({ MUSE_BROWSER_MAX_ACTIONS: "2.5" })).toBe(30);
  });

  it("falls back to the default for a non-numeric value", () => {
    expect(resolveBrowserMaxActions({ MUSE_BROWSER_MAX_ACTIONS: "abc" })).toBe(30);
  });
});
