import { describe, expect, it } from "vitest";

import { parseJwtRotationState } from "../src/index.js";

const TIMESTAMP = "2026-07-16T00:00:00.000Z";
const SECRET = "x".repeat(32);

describe("parseJwtRotationState", () => {
  it("accepts the canonical rotation state written by the CLI", () => {
    expect(parseJwtRotationState({
      current: SECRET,
      rotatedAt: TIMESTAMP,
      previous: [{ secret: "y".repeat(32), rotatedAt: TIMESTAMP, validUntil: "2026-07-17T00:00:00.000Z" }]
    })).toEqual({
      current: SECRET,
      rotatedAt: TIMESTAMP,
      previous: [{ secret: "y".repeat(32), rotatedAt: TIMESTAMP, validUntil: "2026-07-17T00:00:00.000Z" }]
    });
  });

  it("rejects malformed current state and skips malformed historical entries", () => {
    expect(parseJwtRotationState({ current: SECRET, rotatedAt: "2026-07-16", previous: [] })).toBeUndefined();
    expect(parseJwtRotationState({
      current: SECRET,
      rotatedAt: TIMESTAMP,
      previous: [{ secret: "y".repeat(32), rotatedAt: TIMESTAMP, validUntil: "invalid" }]
    })?.previous).toEqual([]);
  });
});
