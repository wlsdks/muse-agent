import { describe, expect, it } from "vitest";

import { pruneExpiredPreviousSecrets, rotateJwtState, type JwtRotationState } from "./jwt-rotation-store.js";

const NOW = new Date("2026-05-26T00:00:00.000Z");
const prev = (secret: string, validUntilIso: string) => ({ secret, rotatedAt: "2026-05-01T00:00:00.000Z", validUntil: validUntilIso });

describe("pruneExpiredPreviousSecrets", () => {
  it("drops entries whose validUntil has passed, keeps still-valid ones", () => {
    const state: JwtRotationState = {
      current: "cur",
      rotatedAt: NOW.toISOString(),
      previous: [prev("old", "2026-05-25T00:00:00.000Z"), prev("fresh", "2026-05-27T00:00:00.000Z")]
    };
    expect(pruneExpiredPreviousSecrets(state, NOW).previous.map((p) => p.secret)).toEqual(["fresh"]);
  });
  it("returns the same object when nothing expired (no needless copy)", () => {
    const state: JwtRotationState = { current: "c", rotatedAt: NOW.toISOString(), previous: [prev("a", "2026-06-01T00:00:00.000Z")] };
    expect(pruneExpiredPreviousSecrets(state, NOW)).toBe(state);
  });
  it("drops entries with an unparseable validUntil", () => {
    const state: JwtRotationState = { current: "c", rotatedAt: NOW.toISOString(), previous: [prev("bad", "not-a-date")] };
    expect(pruneExpiredPreviousSecrets(state, NOW).previous).toEqual([]);
  });
});

describe("rotateJwtState", () => {
  const secretFactory = () => "NEWSECRET";

  it("first-time (no state, no fallback) promotes a fresh secret, no previous", () => {
    const out = rotateJwtState({ state: undefined, now: NOW, graceMs: 1000, secretFactory });
    expect(out).toMatchObject({ current: "NEWSECRET", previous: [] });
  });

  it("moves the existing current into previous with a grace window, mints a new current", () => {
    const state: JwtRotationState = { current: "OLD", rotatedAt: "2026-05-01T00:00:00.000Z", previous: [] };
    const out = rotateJwtState({ state, now: NOW, graceMs: 60_000, secretFactory });
    expect(out.current).toBe("NEWSECRET");
    expect(out.previous[0]).toMatchObject({ secret: "OLD", validUntil: new Date(NOW.getTime() + 60_000).toISOString() });
  });

  it("prunes already-expired previous entries during rotation", () => {
    const state: JwtRotationState = {
      current: "OLD",
      rotatedAt: "2026-05-01T00:00:00.000Z",
      previous: [prev("expired", "2026-05-25T00:00:00.000Z")]
    };
    const out = rotateJwtState({ state, now: NOW, graceMs: 60_000, secretFactory });
    expect(out.previous.map((p) => p.secret)).toEqual(["OLD"]); // "expired" pruned, "OLD" added
  });

  it("uses fallbackCurrent as the demoted secret when state is absent", () => {
    const out = rotateJwtState({ state: undefined, fallbackCurrent: "ENVSECRET", now: NOW, graceMs: 1000, secretFactory });
    expect(out.current).toBe("NEWSECRET");
    expect(out.previous[0]?.secret).toBe("ENVSECRET");
  });
});
