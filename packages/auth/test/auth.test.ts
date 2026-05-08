import { describe, expect, it } from "vitest";
import type { MuseDatabase } from "@muse/db";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler
} from "kysely";
import {
  AuthRateLimiter,
  Auth,
  DefaultAuthProvider,
  InMemoryTokenRevocationStore,
  InMemoryUserStore,
  IamTokenExchange,
  JwtTokenProvider,
  createAuthTokenRevocationInsert,
  createUserInsert,
  mapUserRow,
  PasswordHasher,
  anonymousActor,
  currentActor,
  extractBearerToken,
  isAnyAdmin,
  maskedAdminAccountRef,
  normalizeEmail
} from "../src/index.js";

const jwtSecret = "0123456789abcdef0123456789abcdef";

describe("users and password auth", () => {
  it("stores users by normalized account id and authenticates password hashes", () => {
    const store = new InMemoryUserStore();
    const hasher = new PasswordHasher();
    const provider = new DefaultAuthProvider(store, hasher);
    const passwordHash = hasher.hashPassword("correct-password", "fixed-salt");

    const user = store.save({
      email: "USER_ACCOUNT",
      name: "User",
      passwordHash
    });

    expect(normalizeEmail(" USER_ACCOUNT ")).toBe("user_account");
    expect(store.findByEmail("user_account")?.id).toBe(user.id);
    expect(provider.authenticate("user_account", "correct-password")?.id).toBe(user.id);
    expect(provider.authenticate("user_account", "wrong-password")).toBeUndefined();
  });
});

describe("Kysely auth mapping", () => {
  it("builds PostgreSQL payloads for users and token revocations", () => {
    const db = createPostgresBuilder();
    const createdAt = new Date("2026-05-06T00:00:00.000Z");
    const expiresAt = new Date("2026-05-06T01:00:00.000Z");
    const user = createUserInsert({
      createdAt,
      email: " USER_ACCOUNT ",
      id: "user-1",
      name: "User",
      passwordHash: "hash",
      role: "admin"
    });
    const revocation = createAuthTokenRevocationInsert("token-1", expiresAt, createdAt);
    const userSql = db.insertInto("users").values(user).returningAll().compile();
    const revocationSql = db.insertInto("auth_token_revocations").values(revocation).compile();

    expect(userSql.sql).toContain('insert into "users"');
    expect(revocationSql.sql).toContain('insert into "auth_token_revocations"');
    expect(user).toMatchObject({
      email: "user_account",
      id: "user-1",
      role: "admin"
    });
    expect(mapUserRow(user)).toMatchObject({
      email: "user_account",
      id: "user-1",
      role: "admin"
    });
    expect(mapUserRow(user)).not.toHaveProperty("tenantId");
  });
});

describe("jwt tokens and revocation", () => {
  it("creates, validates, extracts, and revokes HS256 tokens", () => {
    const jwt = new JwtTokenProvider({
      jwtExpirationMs: 60_000,
      jwtSecret
    });
    const user = {
      createdAt: new Date("2026-05-05T00:00:00.000Z"),
      email: "user_account",
      id: "user-1",
      name: "User",
      passwordHash: "hash",
      role: "admin" as const
    };
    const now = new Date();
    const token = jwt.createToken(user, now);
    const revocations = new InMemoryTokenRevocationStore(() => new Date(now.getTime() + 1_000));
    const service = new Auth({
      authProvider: { authenticate: () => user, getUserById: () => user },
      jwt,
      revocationStore: revocations
    });

    expect(jwt.validateToken(token, new Date(now.getTime() + 1_000))).toBe("user-1");
    expect(jwt.extractRole(token)).toBe("admin");
    expect(service.authenticateBearer(token)?.userId).toBe("user-1");
    expect(service.logout(token)).toBe(true);
    expect(service.authenticateBearer(token)).toBeUndefined();
    expect(revocations.size()).toBe(1);
  });

  it("rejects weak JWT secrets", () => {
    expect(() => new JwtTokenProvider({ jwtSecret: "short" })).toThrow("JWT secret");
  });
});

describe("Auth registration and login", () => {
  it("registers first user as admin and returns login tokens", () => {
    const store = new InMemoryUserStore();
    const provider = new DefaultAuthProvider(store);
    const service = new Auth({
      authProvider: provider,
      jwt: new JwtTokenProvider({ jwtSecret }),
      userStore: store
    });
    const registered = service.register({
      email: "first_account",
      name: "First",
      password: "password-1"
    });
    const login = service.login("first_account", "password-1");
    const changed = service.changePassword({
      currentPassword: "password-1",
      newPassword: "password-2",
      userId: registered.user.id
    });

    expect(registered.user.role).toBe("admin");
    expect(login?.token).toBeTruthy();
    expect(login?.user).not.toHaveProperty("passwordHash");
    expect(changed).toBe("changed");
    expect(service.login("first_account", "password-1")).toBeUndefined();
    expect(service.login("first_account", "password-2")?.user.id).toBe(registered.user.id);
    expect(service.changePassword({
      currentPassword: "wrong",
      newPassword: "password-3",
      userId: registered.user.id
    })).toBe("invalid_current_password");
  });
});

describe("IamTokenExchange", () => {
  it("exchanges verified IAM claims into Muse JWTs and auto-creates users", async () => {
    const store = new InMemoryUserStore();
    const jwt = new JwtTokenProvider({ jwtSecret });
    const service = new IamTokenExchange({
      idFactory: () => "iam-user-1",
      jwt,
      userStore: store,
      verifier: {
        verify: (token) => token === "iam-token"
          ? { email: "IAM_USER@example.com", roles: ["ROLE_ADMIN"], sub: "iam-user" }
          : undefined
      }
    });

    const exchanged = await service.exchange("iam-token");
    const secondExchange = await service.exchange("iam-token");
    const identity = jwt.parseToken(exchanged?.token ?? "");

    expect(exchanged?.user).toMatchObject({
      email: "iam_user@example.com",
      id: "iam-user-1",
      name: "IAM_USER",
      role: "admin"
    });
    expect(identity).toMatchObject({ role: "admin", sub: "iam-user-1" });
    expect(secondExchange?.user.id).toBe("iam-user-1");
    expect(store.count()).toBe(1);
  });

  it("rejects invalid IAM tokens and respects disabled auto-create", async () => {
    const store = new InMemoryUserStore();
    const service = new IamTokenExchange({
      autoCreateUser: false,
      jwt: new JwtTokenProvider({ jwtSecret }),
      userStore: store,
      verifier: {
        verify: () => ({ roles: ["ROLE_ADMIN"], sub: "iam-user" })
      }
    });

    await expect(service.exchange("iam-token")).resolves.toBeUndefined();
    await expect(service.exchange("")).resolves.toBeUndefined();
    expect(store.count()).toBe(0);
  });
});

describe("authorization helpers", () => {
  it("recognises admin role and masks actors", () => {
    expect(isAnyAdmin("admin")).toBe(true);
    expect(isAnyAdmin("user")).toBe(false);
    expect(currentActor(undefined)).toBe(anonymousActor);
    expect(maskedAdminAccountRef("admin-1")).toMatch(/^admin-account:[a-f0-9]{12}$/u);
    expect(maskedAdminAccountRef(anonymousActor)).toBe("admin-account:anonymous");
  });

  it("extracts bearer tokens conservatively", () => {
    expect(extractBearerToken("Bearer token-1")).toBe("token-1");
    expect(extractBearerToken("Basic token-1")).toBeUndefined();
  });
});

describe("AuthRateLimiter", () => {
  it("blocks after configured failures and does not clear on unknown status", () => {
    let now = 0;
    const limiter = new AuthRateLimiter({
      maxAttemptsPerMinute: 2,
      now: () => now,
      windowMs: 1_000
    });

    limiter.recordFailure("ip:/auth/login");
    limiter.recordCompletedAttempt("ip:/auth/login", undefined);
    expect(limiter.isBlocked("ip:/auth/login")).toBe(false);

    limiter.recordFailure("ip:/auth/login");
    expect(limiter.isBlocked("ip:/auth/login")).toBe(true);

    now += 1_000;
    expect(limiter.isBlocked("ip:/auth/login")).toBe(false);
  });

  it("clears failures only on explicit success", () => {
    const limiter = new AuthRateLimiter({ maxAttemptsPerMinute: 1 });

    limiter.recordFailure("ip:/auth/login");
    limiter.recordCompletedAttempt("ip:/auth/login", 200);

    expect(limiter.isBlocked("ip:/auth/login")).toBe(false);
  });
});

function createPostgresBuilder(): Kysely<MuseDatabase> {
  return new Kysely<MuseDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler()
    }
  });
}
