/**
 * JWT signing + verification + the `JwtTokenProvider` class. Lives
 * in a leaf module so `./index.ts` can stay focused on the user-
 * store + Auth/AsyncAuth orchestration. The public surface
 * (`JwtTokenProvider`) is re-exported from `./index.ts` so external
 * call-sites stay byte-identical.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

import { createRunId } from "@muse/shared";

import { AuthError } from "./auth-error.js";

export const defaultJwtExpirationMs = 86_400_000;
const minimumJwtSecretBytes = 32;

/**
 * Internal — only `JwtTokenProvider`'s constructor reads this.
 */
export interface AuthProperties {
  readonly jwtSecret: string;
  readonly jwtExpirationMs?: number;
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

  constructor(private readonly properties: AuthProperties) {
    this.jwtExpirationMs = properties.jwtExpirationMs ?? defaultJwtExpirationMs;
    this.secret = Buffer.from(properties.jwtSecret);

    if (this.secret.byteLength < minimumJwtSecretBytes) {
      throw new AuthError(
        "WEAK_JWT_SECRET",
        `JWT secret must be at least ${minimumJwtSecretBytes} bytes for HS256`
      );
    }
  }

  createToken(user: JwtUser, now = new Date()): string {
    const issuedAt = Math.floor(now.getTime() / 1_000);
    const expiresAt = Math.floor((now.getTime() + this.jwtExpirationMs) / 1_000);
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
    const claims = verifyJwt(token, this.secret);

    if (!claims || claims.exp <= Math.floor(now.getTime() / 1_000)) {
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
    return claims ? new Date(claims.exp * 1_000) : undefined;
  }
}

function signJwt(claims: JwtClaims, secret: Buffer): string {
  const header = { alg: "HS256", typ: "JWT" };
  const unsigned = `${base64UrlJson(header)}.${base64UrlJson(claims)}`;
  const signature = createHmac("sha256", secret).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
}

function verifyJwt(token: string, secret: Buffer): JwtClaims | undefined {
  const [header, payload, signature] = token.split(".");

  if (!header || !payload || !signature) {
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

function isJwtClaims(value: unknown): value is JwtClaims {
  return (
    isRecord(value) &&
    typeof value.sub === "string" &&
    typeof value.jti === "string" &&
    typeof value.email === "string" &&
    typeof value.iat === "number" &&
    typeof value.exp === "number"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
