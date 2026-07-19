import { describe, expect, it } from "vitest";

import { shouldInvalidateOnReconnect } from "./reconnect.js";

describe("shouldInvalidateOnReconnect — nudge queries to refetch on the genuine offline -> online edge", () => {
  it("fires on the offline -> online edge (previous settled false, now settled true)", () => {
    expect(shouldInvalidateOnReconnect(false, true)).toBe(true);
  });

  it("does NOT fire on the very first resolution (unknown -> true) — a fresh page load", () => {
    expect(shouldInvalidateOnReconnect(undefined, true)).toBe(false);
  });

  it("does not fire while staying online (true -> true)", () => {
    expect(shouldInvalidateOnReconnect(true, true)).toBe(false);
  });

  it("does not fire on the online -> offline edge", () => {
    expect(shouldInvalidateOnReconnect(true, false)).toBe(false);
  });

  it("does not fire while staying offline (false -> false)", () => {
    expect(shouldInvalidateOnReconnect(false, false)).toBe(false);
  });

  it("does not fire when the current state is still unresolved", () => {
    expect(shouldInvalidateOnReconnect(false, undefined)).toBe(false);
  });
});
