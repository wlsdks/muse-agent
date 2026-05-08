import { describe, expect, it } from "vitest";

import {
  AuthError,
  AuthRateLimiter,
  Auth,
  DefaultAuthProvider,
  InMemoryTokenRevocationStore,
  InMemoryUserStore,
  JwtTokenProvider,
  PasswordHasher,
  anonymousActor,
  currentActor,
  extractBearerToken,
  isAnyAdmin,
  maskedAdminAccountRef,
  normalizeEmail,
  type User
} from "../src/index.js";

const strongSecret = "x".repeat(48);

function makeService() {
  const userStore = new InMemoryUserStore();
  const revocationStore = new InMemoryTokenRevocationStore();
  const authProvider = new DefaultAuthProvider(userStore);
  const jwt = new JwtTokenProvider({ jwtSecret: strongSecret });
  const service = new Auth({ authProvider, jwt, revocationStore, userStore });
  return { authProvider, jwt, revocationStore, service, userStore };
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
    passwordHash: "v1:salt:hash",
    role: "user"
  };

  it("creates a token, validates the subject, and surfaces the role", () => {
    const token = jwt.createToken(sampleUser);
    expect(jwt.validateToken(token)).toBe("user-1");
    expect(jwt.extractRole(token)).toBe("user");
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

  it("logout revokes the token so authenticateBearer returns undefined afterwards", () => {
    const { service } = makeService();
    const login = service.register({ email: "d@example.com", name: "D", password: "pw" });
    expect(service.logout(login.token)).toBe(true);
    expect(service.authenticateBearer(login.token)).toBeUndefined();
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

describe("Auth.updateUserRole", () => {
  it("promotes a user to admin and returns the public projection", () => {
    const { service } = makeService();
    const registration = service.register({ email: "e@example.com", name: "E", password: "pw" });
    const promoted = service.updateUserRole(registration.user.id, "admin");
    expect(promoted?.role).toBe("admin");
  });

  it("returns undefined when the user does not exist", () => {
    const { service } = makeService();
    expect(service.updateUserRole("ghost", "admin")).toBeUndefined();
  });
});

describe("AuthRateLimiter", () => {
  it("blocks once maxAttempts is reached and unblocks once the window passes", () => {
    let now = 0;
    const limiter = new AuthRateLimiter({
      maxAttemptsPerMinute: 3,
      now: () => now,
      windowMs: 1_000
    });
    const key = "user:127.0.0.1";
    expect(limiter.isBlocked(key)).toBe(false);
    limiter.recordFailure(key);
    limiter.recordFailure(key);
    expect(limiter.isBlocked(key)).toBe(false);
    limiter.recordFailure(key);
    expect(limiter.isBlocked(key)).toBe(true);

    // Inside the window, even a success-coded completion clears.
    limiter.recordSuccess(key);
    expect(limiter.isBlocked(key)).toBe(false);
  });

  it("auto-expires entries when isBlocked is queried after the window", () => {
    let now = 0;
    const limiter = new AuthRateLimiter({
      maxAttemptsPerMinute: 1,
      now: () => now,
      windowMs: 100
    });
    limiter.recordFailure("k");
    expect(limiter.isBlocked("k")).toBe(true);
    now += 200;
    expect(limiter.isBlocked("k")).toBe(false);
  });

  it("recordCompletedAttempt mirrors success/failure on 2xx vs 4xx and ignores 3xx/undefined", () => {
    let now = 0;
    const limiter = new AuthRateLimiter({
      maxAttemptsPerMinute: 2,
      now: () => now,
      windowMs: 1_000
    });
    limiter.recordCompletedAttempt("k", 401);
    expect(limiter.isBlocked("k")).toBe(false);
    limiter.recordCompletedAttempt("k", 403);
    expect(limiter.isBlocked("k")).toBe(true);
    limiter.recordCompletedAttempt("k", 200);
    expect(limiter.isBlocked("k")).toBe(false);
    // 3xx and undefined should be no-ops.
    limiter.recordCompletedAttempt("k", 302);
    limiter.recordCompletedAttempt("k", undefined);
    expect(limiter.isBlocked("k")).toBe(false);
  });
});

describe("authorization helpers", () => {
  it("isAnyAdmin recognises only the admin role", () => {
    expect(isAnyAdmin("admin")).toBe(true);
    expect(isAnyAdmin("user")).toBe(false);
    expect(isAnyAdmin(null)).toBe(false);
    expect(isAnyAdmin(undefined)).toBe(false);
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
        role: "user",
        tokenId: "t-1",
        userId: "    "
      })
    ).toBe(anonymousActor);
    expect(
      currentActor({
        accountId: "acct",
        email: "a@b.c",
        expiresAt: new Date(),
        role: "user",
        tokenId: "t-1",
        userId: "user-1"
      })
    ).toBe("user-1");
  });

  it("maskedAdminAccountRef is deterministic, hex-truncated, and special-cases anonymous + empty", () => {
    expect(maskedAdminAccountRef(undefined)).toBe("admin-account:unknown");
    expect(maskedAdminAccountRef("")).toBe("admin-account:unknown");
    expect(maskedAdminAccountRef(anonymousActor)).toBe(`admin-account:${anonymousActor}`);
    const masked = maskedAdminAccountRef("user-42");
    expect(masked).toMatch(/^admin-account:[0-9a-f]{12}$/u);
    expect(maskedAdminAccountRef("user-42")).toBe(masked); // deterministic
    expect(maskedAdminAccountRef("user-43")).not.toBe(masked);
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
});

describe("normalizeEmail", () => {
  it("lowercases and trims surrounding whitespace", () => {
    expect(normalizeEmail("  USER@Example.COM  ")).toBe("user@example.com");
  });

  it("returns the empty string for whitespace-only input", () => {
    expect(normalizeEmail("   ")).toBe("");
  });
});
