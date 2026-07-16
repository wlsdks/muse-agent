import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { AuthError } from "../src/auth-error.js";
import { JwtTokenProvider, defaultJwtExpirationMs } from "../src/jwt.js";

const SECRET = "0123456789abcdef0123456789abcdef"; // exactly 32 bytes
const SECRET2 = "ZYXWVUTSRQPONMLKJIHGFEDCBA987654"; // 32 bytes, distinct
const USER = { id: "u1", email: "a@b.com" };

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
/** Mirror of the module's private signJwt, for crafting verify-branch inputs. */
const sign = (header: unknown, payload: string, secret: string) => {
  const unsigned = `${b64(header)}.${payload}`;
  return `${unsigned}.${createHmac("sha256", Buffer.from(secret)).update(unsigned).digest("base64url")}`;
};
const validClaims = { sub: "u1", jti: "j1", email: "a@b.com", iat: 1, exp: 9_999_999_999 };

describe("JwtTokenProvider constructor", () => {
  it("constructs with a 32-byte secret and signs a three-segment token", () => {
    expect(new JwtTokenProvider({ jwtSecret: SECRET }).createToken(USER).split(".")).toHaveLength(3);
  });

  it("rejects a secret shorter than 32 bytes", () => {
    expect(() => new JwtTokenProvider({ jwtSecret: "short" })).toThrowError(
      expect.objectContaining({ code: "WEAK_JWT_SECRET" }) as AuthError,
    );
  });

  it("rejects any previous rotation secret shorter than 32 bytes", () => {
    expect(() => new JwtTokenProvider({ jwtSecret: SECRET, previousJwtSecrets: [SECRET2, "short"] })).toThrowError(
      expect.objectContaining({ code: "WEAK_JWT_SECRET" }) as AuthError,
    );
  });

  it("rejects a non-positive or non-finite expiration", () => {
    for (const jwtExpirationMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new JwtTokenProvider({ jwtSecret: SECRET, jwtExpirationMs })).toThrowError(
        expect.objectContaining({ code: "INVALID_JWT_EXPIRATION" }) as AuthError,
      );
    }
  });
});

describe("createToken / parseToken round-trip", () => {
  const provider = new JwtTokenProvider({ jwtSecret: SECRET });
  const now = new Date("2026-01-01T00:00:00Z");

  it("round-trips the full claim set", () => {
    const claims = provider.parseToken(provider.createToken(USER, now), now);
    expect(claims).toMatchObject({ sub: "u1", email: "a@b.com" });
    expect(typeof claims?.jti).toBe("string");
    expect(claims?.iat).toBe(Math.floor(now.getTime() / 1000));
    expect(claims?.exp).toBe(Math.floor((now.getTime() + defaultJwtExpirationMs) / 1000));
  });

  it("validateToken returns the subject for a fresh token", () => {
    expect(provider.validateToken(provider.createToken(USER, now), now)).toBe("u1");
  });

  it("rejects a token at or after its expiry", () => {
    const token = provider.createToken(USER, now);
    const afterExpiry = new Date(now.getTime() + defaultJwtExpirationMs + 1);
    expect(provider.parseToken(token, afterExpiry)).toBeUndefined();
    expect(provider.validateToken(token, afterExpiry)).toBeUndefined();
  });

  it("honours a custom expiration window", () => {
    const shortLived = new JwtTokenProvider({ jwtSecret: SECRET, jwtExpirationMs: 1000 });
    const token = shortLived.createToken(USER, now);
    expect(shortLived.validateToken(token, new Date(now.getTime() + 500))).toBe("u1");
    expect(shortLived.validateToken(token, new Date(now.getTime() + 2000))).toBeUndefined();
  });

  it("fails closed when a caller supplies an invalid clock", () => {
    const invalidNow = new Date("invalid");
    const token = provider.createToken(USER, now);
    expect(() => provider.createToken(USER, invalidNow)).toThrow(RangeError);
    expect(provider.parseToken(token, invalidNow)).toBeUndefined();
  });

  it("rejects an expiration duration outside JavaScript's Date range", () => {
    const impractical = new JwtTokenProvider({ jwtSecret: SECRET, jwtExpirationMs: Number.MAX_VALUE });
    expect(() => impractical.createToken(USER, now)).toThrow(RangeError);
  });
});

describe("extract* accessors (operate on a currently-valid token)", () => {
  const provider = new JwtTokenProvider({ jwtSecret: SECRET });
  // No `now` override on these accessors, so the token must be valid at
  // real wall-clock time — create it with the default (real) now.
  const token = provider.createToken(USER);

  it("extracts email and token id", () => {
    expect(provider.extractEmail(token)).toBe("a@b.com");
    expect(typeof provider.extractTokenId(token)).toBe("string");
  });

  it("extracts the expiration as a Date roughly now + default window", () => {
    const exp = provider.extractExpiration(token);
    expect(exp).toBeInstanceOf(Date);
    const deltaMs = exp!.getTime() - Date.now();
    expect(deltaMs).toBeGreaterThan(defaultJwtExpirationMs - 60_000);
    expect(deltaMs).toBeLessThanOrEqual(defaultJwtExpirationMs + 1000);
  });

  it("returns undefined for an expired or malformed token", () => {
    const expired = provider.createToken(USER, new Date("2000-01-01T00:00:00Z"));
    expect(provider.extractEmail(expired)).toBeUndefined();
    expect(provider.extractExpiration("garbage")).toBeUndefined();
  });
});

describe("verifyJwt rejection branches", () => {
  const provider = new JwtTokenProvider({ jwtSecret: SECRET });
  const now = new Date("2026-01-01T00:00:00Z");

  it("rejects tokens without exactly three non-empty segments", () => {
    for (const token of ["", "onlyone", "two.parts", "a.b.c.d", "a..c", ".b.c", "a.b."]) {
      expect(provider.parseToken(token, now)).toBeUndefined();
    }
  });

  it("rejects a valid compact JWT with an appended fourth segment", () => {
    const token = provider.createToken(USER, now);
    expect(provider.parseToken(`${token}.trailing`, now)).toBeUndefined();
  });

  it("rejects a noncanonical base64url signature that decodes to the same bytes", () => {
    const token = provider.createToken(USER, now);
    const [header, payload, signature] = token.split(".");
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = signature.at(-1)!;
    const noncanonicalLast = alphabet[(alphabet.indexOf(last) & ~3) | 1]!;
    expect(provider.parseToken(`${header}.${payload}.${signature.slice(0, -1)}${noncanonicalLast}`, now)).toBeUndefined();
  });

  it("rejects a tampered payload or signature", () => {
    const token = provider.createToken(USER, now);
    const [h, p, s] = token.split(".");
    expect(provider.parseToken(`${h}.${b64({ ...validClaims, sub: "attacker" })}.${s}`, now)).toBeUndefined();
    expect(provider.parseToken(`${h}.${p}.${s.slice(0, -2)}xx`, now)).toBeUndefined();
  });

  it("rejects a token signed with an unknown secret", () => {
    const forged = sign({ alg: "HS256", typ: "JWT" }, b64(validClaims), "an-entirely-different-32byte-secret!");
    expect(provider.parseToken(forged, now)).toBeUndefined();
  });

  it("rejects a non-HS256 alg even when the HMAC signature is valid (alg substitution)", () => {
    const forged = sign({ alg: "HS512", typ: "JWT" }, b64(validClaims), SECRET);
    expect(provider.parseToken(forged, now)).toBeUndefined();
  });

  it("rejects a validly-signed but non-JSON or wrong-shaped payload", () => {
    const notJson = sign({ alg: "HS256", typ: "JWT" }, Buffer.from("not json").toString("base64url"), SECRET);
    expect(provider.parseToken(notJson, now)).toBeUndefined();
    const wrongShape = sign({ alg: "HS256", typ: "JWT" }, b64({ sub: 1, jti: "j", email: "e", iat: 1, exp: 9e9 }), SECRET);
    expect(provider.parseToken(wrongShape, now)).toBeUndefined();
  });
});

describe("expiry boundary (the exp <= now comparison is inclusive)", () => {
  const provider = new JwtTokenProvider({ jwtSecret: SECRET });
  const now = new Date("2026-01-01T00:00:00Z");
  const nowSec = Math.floor(now.getTime() / 1000);

  it("rejects a token whose exp equals the current second (boundary is <=, not <)", () => {
    const atBoundary = sign({ alg: "HS256", typ: "JWT" }, b64({ ...validClaims, exp: nowSec }), SECRET);
    expect(provider.parseToken(atBoundary, now)).toBeUndefined();
  });

  it("accepts a token whose exp is one second past now (just inside the window)", () => {
    const oneSecLater = sign({ alg: "HS256", typ: "JWT" }, b64({ ...validClaims, exp: nowSec + 1 }), SECRET);
    expect(provider.parseToken(oneSecLater, now)?.sub).toBe("u1");
  });
});

describe("extractExpiration overflow guard", () => {
  const provider = new JwtTokenProvider({ jwtSecret: SECRET });

  it("returns undefined when a valid token's exp overflows the Date range (exp*1000 is non-finite)", () => {
    // exp = 1e20 passes isJwtClaims (finite) and parseToken (far in the future,
    // so not expired), but new Date(1e20 * 1000) is an Invalid Date — the
    // Number.isFinite guard must drop it rather than hand back a NaN-time Date.
    const absurd = sign({ alg: "HS256", typ: "JWT" }, b64({ ...validClaims, exp: 1e20 }), SECRET);
    expect(provider.parseToken(absurd)?.sub).toBe("u1");
    expect(provider.extractExpiration(absurd)).toBeUndefined();
  });
});

describe("secret rotation grace window", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const oldProvider = new JwtTokenProvider({ jwtSecret: SECRET });
  const token = oldProvider.createToken(USER, now);

  it("still validates a token signed with a now-previous secret", () => {
    const rotated = new JwtTokenProvider({ jwtSecret: SECRET2, previousJwtSecrets: [SECRET] });
    expect(rotated.validateToken(token, now)).toBe("u1");
  });

  it("rejects the old token once the secret is no longer listed", () => {
    const rotatedNoGrace = new JwtTokenProvider({ jwtSecret: SECRET2 });
    expect(rotatedNoGrace.validateToken(token, now)).toBeUndefined();
  });
});
