import { describe, expect, it } from "vitest";

import {
  AuthError,
  Auth,
  DefaultAuthProvider,
  InMemoryUserStore,
  JwtTokenProvider,
  PasswordHasher,
  anonymousActor,
  currentActor,
  extractBearerToken,
  normalizeEmail,
  type User
} from "../src/index.js";

const strongSecret = "x".repeat(48);

function makeService() {
  const userStore = new InMemoryUserStore();
  const authProvider = new DefaultAuthProvider(userStore);
  const jwt = new JwtTokenProvider({ jwtSecret: strongSecret });
  const service = new Auth({ authProvider, jwt, userStore });
  return { authProvider, jwt, service, userStore };
}

describe("PasswordHasher", () => {
  const hasher = new PasswordHasher();

  it("round-trips a password and rejects mismatches via timing-safe comparison", () => {
    const hash = hasher.hashPassword("muse-jarvis");
    expect(hasher.verify("muse-jarvis", hash)).toBe(true);
    expect(hasher.verify("muse-jarvi", hash)).toBe(false);
    expect(hasher.verify("MUSE-JARVIS", hash)).toBe(false);
  });

  it("rejects malformed hashes", () => {
    expect(hasher.verify("muse", "not-a-real-hash")).toBe(false);
    expect(hasher.verify("muse", "v999:salt:hash")).toBe(false);
    expect(hasher.verify("muse", "")).toBe(false);
  });

  it("produces a different salt per call (so two hashes of the same password differ)", () => {
    const a = hasher.hashPassword("same");
    const b = hasher.hashPassword("same");
    expect(a).not.toBe(b);
    expect(hasher.verify("same", a)).toBe(true);
    expect(hasher.verify("same", b)).toBe(true);
  });
});

describe("JwtTokenProvider edge cases", () => {
  const jwt = new JwtTokenProvider({ jwtSecret: strongSecret, jwtExpirationMs: 60_000 });
  const sampleUser: User = {
    createdAt: new Date(),
    email: "user@example.com",
    id: "user-1",
    name: "User",
    passwordHash: "v1:salt:hash"
  };

  it("creates a token and validates the subject", () => {
    const token = jwt.createToken(sampleUser);
    expect(jwt.validateToken(token)).toBe("user-1");
  });

  it("returns undefined for an expired token", () => {
    const past = new Date(Date.now() - 120_000);
    const token = jwt.createToken(sampleUser, past);
    expect(jwt.parseToken(token)).toBeUndefined();
    expect(jwt.validateToken(token)).toBeUndefined();
  });

  it("returns undefined for malformed or empty tokens", () => {
    expect(jwt.parseToken("")).toBeUndefined();
    expect(jwt.parseToken("not.a.jwt")).toBeUndefined();
    expect(jwt.validateToken("garbage")).toBeUndefined();
  });

  it("rejects a token signed by a different secret", () => {
    const other = new JwtTokenProvider({ jwtSecret: "y".repeat(48) });
    const token = other.createToken(sampleUser);
    expect(jwt.parseToken(token)).toBeUndefined();
  });

  it("rejects a JWT secret shorter than the HS256 minimum", () => {
    expect(() => new JwtTokenProvider({ jwtSecret: "short" })).toThrow(AuthError);
  });
});

describe("Auth.changePassword", () => {
  it("returns 'changed' on the happy path and the new password authenticates", () => {
    const { service, userStore, authProvider } = makeService();
    const registration = service.register({ email: "a@example.com", name: "A", password: "old-pass" });
    const result = service.changePassword({
      currentPassword: "old-pass",
      newPassword: "new-pass",
      userId: registration.user.id
    });
    expect(result).toBe("changed");
    const refreshed = userStore.findById(registration.user.id);
    expect(refreshed).toBeDefined();
    expect(authProvider.authenticate("a@example.com", "new-pass")).toBeDefined();
    expect(authProvider.authenticate("a@example.com", "old-pass")).toBeUndefined();
  });

  it("returns 'invalid_current_password' when the old password is wrong", () => {
    const { service } = makeService();
    const registration = service.register({ email: "b@example.com", name: "B", password: "old" });
    expect(
      service.changePassword({ currentPassword: "wrong", newPassword: "new", userId: registration.user.id })
    ).toBe("invalid_current_password");
  });

  it("returns 'user_not_found' for a missing userId", () => {
    const { service } = makeService();
    expect(
      service.changePassword({ currentPassword: "x", newPassword: "y", userId: "ghost" })
    ).toBe("user_not_found");
  });
});

describe("Auth logout / authenticateBearer", () => {
  it("authenticateBearer returns the identity for a fresh token", () => {
    const { service } = makeService();
    const login = service.register({ email: "c@example.com", name: "C", password: "pw" });
    const identity = service.authenticateBearer(login.token);
    expect(identity?.userId).toBe(login.user.id);
    expect(identity?.email).toBe("c@example.com");
  });

  it("logout returns true for a parseable token (no server-side revocation)", () => {
    const { service } = makeService();
    const login = service.register({ email: "d@example.com", name: "D", password: "pw" });
    expect(service.logout(login.token)).toBe(true);
  });

  it("logout returns false for missing or malformed tokens", () => {
    const { service } = makeService();
    expect(service.logout(undefined)).toBe(false);
    expect(service.logout("garbage")).toBe(false);
  });

  it("authenticateBearer returns undefined for missing token", () => {
    const { service } = makeService();
    expect(service.authenticateBearer(undefined)).toBeUndefined();
    expect(service.authenticateBearer("")).toBeUndefined();
  });
});

describe("actor helpers", () => {
  it("currentActor falls back to the anonymous sentinel when identity or userId is missing", () => {
    expect(currentActor(undefined)).toBe(anonymousActor);
    expect(
      currentActor({
        accountId: "acct",
        email: "a@b.c",
        expiresAt: new Date(),
        tokenId: "t-1",
        userId: "    "
      })
    ).toBe(anonymousActor);
    expect(
      currentActor({
        accountId: "acct",
        email: "a@b.c",
        expiresAt: new Date(),
        tokenId: "t-1",
        userId: "user-1"
      })
    ).toBe("user-1");
  });

});

describe("extractBearerToken", () => {
  it("accepts case-insensitive Bearer prefix and trims whitespace", () => {
    expect(extractBearerToken("Bearer abc")).toBe("abc");
    expect(extractBearerToken("bearer abc")).toBe("abc");
    expect(extractBearerToken("BEARER abc")).toBe("abc");
    expect(extractBearerToken("Bearer    spaced")).toBe("spaced");
  });

  it("rejects non-bearer schemes, missing tokens, and undefined headers", () => {
    expect(extractBearerToken(undefined)).toBeUndefined();
    expect(extractBearerToken("Basic abc")).toBeUndefined();
    expect(extractBearerToken("Bearer ")).toBeUndefined();
    expect(extractBearerToken("Bearer")).toBeUndefined();
    expect(extractBearerToken("")).toBeUndefined();
  });

  it("tolerates leading / trailing whitespace + tab separators (goal 122)", () => {
    // Leading whitespace previously broke the parser — split put
    // an empty string at index 0 so scheme never matched.
    expect(extractBearerToken(" Bearer abc")).toBe("abc");
    expect(extractBearerToken("   Bearer abc")).toBe("abc");
    // Trailing whitespace is harmless either way; pin the
    // expected behaviour.
    expect(extractBearerToken("Bearer abc ")).toBe("abc");
    expect(extractBearerToken("Bearer abc   ")).toBe("abc");
    // Tab between scheme and token is valid per RFC 7235's
    // 1*( OWS / DIGIT ) allowance; \s+ already covered it but
    // explicit assertion keeps the contract pinned.
    expect(extractBearerToken("Bearer\tabc")).toBe("abc");
    // Pure whitespace remains rejected (trimming to "" short-circuits).
    expect(extractBearerToken("   ")).toBeUndefined();
  });
});

describe("normalizeEmail", () => {
  it("lowercases and trims surrounding whitespace", () => {
    expect(normalizeEmail("  USER@Example.COM  ")).toBe("user@example.com");
  });

  it("returns the empty string for whitespace-only input", () => {
    expect(normalizeEmail("   ")).toBe("");
  });
});
