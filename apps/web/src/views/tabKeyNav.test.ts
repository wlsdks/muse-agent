import { describe, expect, it } from "vitest";

import { nextTabIndex } from "./tabKeyNav.js";

describe("nextTabIndex", () => {
  it("moves to the next tab and wraps forward", () => {
    expect(nextTabIndex(0, "ArrowRight", 3)).toBe(1);
    expect(nextTabIndex(2, "ArrowRight", 3)).toBe(0); // wrap
  });

  it("moves to the previous tab and wraps back", () => {
    expect(nextTabIndex(1, "ArrowLeft", 3)).toBe(0);
    expect(nextTabIndex(0, "ArrowLeft", 3)).toBe(2); // wrap
  });

  it("treats Down as Right and Up as Left", () => {
    expect(nextTabIndex(0, "ArrowDown", 3)).toBe(1);
    expect(nextTabIndex(0, "ArrowUp", 3)).toBe(2);
  });

  it("jumps to first with Home and last with End", () => {
    expect(nextTabIndex(2, "Home", 3)).toBe(0);
    expect(nextTabIndex(0, "End", 3)).toBe(2);
  });

  it("leaves the index unchanged for any other key", () => {
    expect(nextTabIndex(1, "Enter", 3)).toBe(1);
    expect(nextTabIndex(1, "a", 3)).toBe(1);
  });

  it("guards an empty tab set", () => {
    expect(nextTabIndex(0, "ArrowRight", 0)).toBe(0);
  });
});
