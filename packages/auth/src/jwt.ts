/**
 * JWT signing + verification + the `JwtTokenProvider` class. Lives
 * in a leaf module so `./index.ts` can stay focused on the user-
 * store + Auth/AsyncAuth orchestration. The public surface
 * (`JwtTokenProvider`) is re-exported from `./index.ts` so external
 * call-sites stay byte-identical.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { isRecord } from "@muse/shared";

import { createRunId } from "@muse/shared";

import { AuthError } from "./auth-error.js";

export const defaultJwtExpirationMs = 86_400_000;
const minimumJwtSecretBytes = 32;
const canonicalBase64Url = /^[A-Za-z0-9_-]+$/u;

/**
 * Internal — only `JwtTokenProvider`'s constructor reads this.
 *
 * `previousJwtSecrets` enables zero-downtime secret rotation: set
 * a new `jwtSecret`, list the old one in `previousJwtSecrets`, and
 * outstanding tokens stay valid until they expire. New tokens are
 * always signed with `jwtSecret`. Verification walks the array
 * (current first, then previous) so a compromised secret can be
 * rotated out without invalidating every active session.
 */
export interface AuthProperties {
  readonly jwtSecret: string;
  readonly jwtExpirationMs?: number;
  readonly previousJwtSecrets?: readonly string[];
}

/** Internal — encoded into JWTs by `JwtTokenProvider` + decoded back. */
export interface JwtClaims {
  readonly sub: string;
  readonly jti: string;
  readonly email: string;
  readonly iat: number;
  readonly exp: number;
  readonly accountId?: string;
}

/**
 * Minimal user shape consumed by `createToken`. The full `User`
 * type lives in `./index.ts`; duplicating just the two fields we
 * need keeps this module a leaf (no `./index.js` dependency, so
 * no cycle).
 */
interface JwtUser {
  readonly id: string;
  readonly email: string;
}

export class JwtTokenProvider {
  private readonly jwtExpirationMs: number;
  private readonly secret: Buffer;
  /**
   * Decoded previous secrets (rotation grace window). Verification
   * tries `secret` first, then walks this array; signing always
   * uses `secret`. Each entry must independently meet the 32-byte
   * minimum so a tiny leftover doesn't weaken the verifier.
   */
  private readonly previousSecrets: readonly Buffer[];

  constructor(private readonly properties: AuthProperties) {
    this.jwtExpirationMs = properties.jwtExpirationMs ?? defaultJwtExpirationMs;
    // `?? default` does NOT catch NaN / Infinity / negative / 0 — any
    // of those silently mints tokens that are instantly invalid or
    // pre-expired (total auth outage with no diagnostic). Fail fast,
    // same posture as the secret check below.
    if (!Number.isFinite(this.jwtExpirationMs) || this.jwtExpirationMs <= 0) {
      throw new AuthError(
        "INVALID_JWT_EXPIRATION",
        "jwtExpirationMs must be a positive finite number of milliseconds"
      );
    }
    this.secret = Buffer.from(properties.jwtSecret);

    if (this.secret.byteLength < minimumJwtSecretBytes) {
      throw new AuthError(
        "WEAK_JWT_SECRET",
        `JWT secret must be at least ${minimumJwtSecretBytes} bytes for HS256`
      );
    }

    this.previousSecrets = (properties.previousJwtSecrets ?? []).map((raw) => {
      const buf = Buffer.from(raw);
      if (buf.byteLength < minimumJwtSecretBytes) {
        throw new AuthError(
          "WEAK_JWT_SECRET",
          `Every previousJwtSecret must be at least ${minimumJwtSecretBytes} bytes for HS256`
        );
      }
      return buf;
    });
  }

  createToken(user: JwtUser, now = new Date()): string {
    const nowMs = now.getTime();
    if (!Number.isFinite(nowMs)) {
      throw new RangeError("JWT token creation requires a valid current time");
    }
    const issuedAt = Math.floor(nowMs / 1_000);
    const expiration = new Date(nowMs + this.jwtExpirationMs);
    if (!Number.isFinite(expiration.getTime())) {
      throw new RangeError("JWT expiration exceeds the supported date range");
    }
    const expiresAt = Math.floor(expiration.getTime() / 1_000);
    const claims: JwtClaims = {
      email: user.email,
      exp: expiresAt,
      iat: issuedAt,
      jti: createRunId("token"),
      sub: user.id
    };

    return signJwt(claims, this.secret);
  }

  parseToken(token: string, now = new Date()): JwtClaims | undefined {
    const nowMs = now.getTime();
    if (!Number.isFinite(nowMs)) {
      return undefined;
    }
    let claims = verifyJwt(token, this.secret);
    // Try previous-secret grace window only if current secret rejects.
    if (!claims) {
      for (const previous of this.previousSecrets) {
        const candidate = verifyJwt(token, previous);
        if (candidate) {
          claims = candidate;
          break;
        }
      }
    }

    if (!claims || claims.exp <= Math.floor(nowMs / 1_000)) {
      return undefined;
    }

    return claims;
  }

  validateToken(token: string, now = new Date()): string | undefined {
    return this.parseToken(token, now)?.sub;
  }

  extractEmail(token: string): string | undefined {
    return this.parseToken(token)?.email;
  }

  extractTokenId(token: string): string | undefined {
    return this.parseToken(token)?.jti;
  }

  extractExpiration(token: string): Date | undefined {
    const claims = this.parseToken(token);
    if (!claims) return undefined;
    const date = new Date(claims.exp * 1_000);
    return Number.isFinite(date.getTime()) ? date : undefined;
  }
}

function signJwt(claims: JwtClaims, secret: Buffer): string {
  const header = { alg: "HS256", typ: "JWT" };
  const unsigned = `${base64UrlJson(header)}.${base64UrlJson(claims)}`;
  const signature = createHmac("sha256", secret).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
}

function verifyJwt(token: string, secret: Buffer): JwtClaims | undefined {
  const segments = token.split(".");
  if (segments.length !== 3) {
    return undefined;
  }
  const [header, payload, signature] = segments;

  if (!header || !payload || !signature || ![header, payload, signature].every(isCanonicalBase64Url)) {
    return undefined;
  }

  const expected = createHmac("sha256", secret).update(`${header}.${payload}`).digest("base64url");
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(signature);

  if (expectedBuffer.length !== actualBuffer.length || !timingSafeEqual(expectedBuffer, actualBuffer)) {
    return undefined;
  }

  const parsedHeader = parseBase64UrlJson(header);

  if (!isRecord(parsedHeader) || parsedHeader.alg !== "HS256") {
    return undefined;
  }

  const parsedClaims = parseBase64UrlJson(payload);
  return isJwtClaims(parsedClaims) ? parsedClaims : undefined;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function parseBase64UrlJson(value: string): unknown {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function isCanonicalBase64Url(value: string): boolean {
  return canonicalBase64Url.test(value) && Buffer.from(value, "base64url").toString("base64url") === value;
}

function isJwtClaims(value: unknown): value is JwtClaims {
  return (
    isRecord(value) &&
    typeof value.sub === "string" &&
    typeof value.jti === "string" &&
    typeof value.email === "string" &&
    Number.isFinite(value.iat) &&
    Number.isFinite(value.exp)
  );
}
