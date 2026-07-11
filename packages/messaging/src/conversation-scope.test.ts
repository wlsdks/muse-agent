import { describe, expect, it } from "vitest";

import { effectiveScope } from "./conversation-scope.js";

// Fail-close: only an EXPLICIT "direct" scope counts as a 1:1 chat. Any
// provider that can't determine scope, or a value drifted from schema (a
// future channel type, a typo, an unrelated string), must resolve to
// "shared" — the group-chat safety posture is the deterministic default,
// never something a provider omission accidentally opts out of.
describe("effectiveScope", () => {
  it("returns \"direct\" only for the exact literal \"direct\"", () => {
    expect(effectiveScope("direct")).toBe("direct");
  });

  it("treats undefined as shared (a provider that never stamps scope stays safe-by-default)", () => {
    expect(effectiveScope(undefined)).toBe("shared");
  });

  it("treats the literal \"shared\" as shared", () => {
    expect(effectiveScope("shared")).toBe("shared");
  });

  it("treats any unrecognised value as shared, not direct (fail-close on drift)", () => {
    expect(effectiveScope("group")).toBe("shared");
    expect(effectiveScope("")).toBe("shared");
    expect(effectiveScope("Direct")).toBe("shared");
  });
});
