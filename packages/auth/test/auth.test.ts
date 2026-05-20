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
  Auth,
  DefaultAuthProvider,
  InMemoryUserStore,
  JwtTokenProvider,
  createUserInsert,
  mapUserRow,
  PasswordHasher,
  anonymousActor,
  currentActor,
  extractBearerToken,
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

  it("a failed email-change (target already taken) does not lock the user out", () => {
    const store = new InMemoryUserStore();
    const a = store.save({ email: "a@x.com", name: "A", passwordHash: "ha" });
    store.save({ email: "b@x.com", name: "B", passwordHash: "hb" });

    expect(() =>
      store.update({ email: "b@x.com", id: a.id, name: "A", passwordHash: "ha" })
    ).toThrow(/User already exists/u);

    // A must still resolve under its ORIGINAL email (pre-fix the
    // old key was deleted before the throw → A became a ghost).
    expect(store.findByEmail("a@x.com")?.id).toBe(a.id);
    expect(store.findByEmail("a@x.com")?.email).toBe("a@x.com");
    // B is untouched and the store has exactly the two users.
    expect(store.findByEmail("b@x.com")?.name).toBe("B");
    expect(store.count()).toBe(2);
  });

  it("a successful email-change reindexes under the new email and frees the old", () => {
    const store = new InMemoryUserStore();
    const a = store.save({ email: "old@x.com", name: "A", passwordHash: "ha" });

    const updated = store.update({ email: "new@x.com", id: a.id, name: "A", passwordHash: "ha" });
    expect(updated.email).toBe("new@x.com");
    expect(store.findByEmail("new@x.com")?.id).toBe(a.id);
    expect(store.findByEmail("old@x.com")).toBeUndefined();
    expect(store.count()).toBe(1);
  });
});

describe("Kysely auth mapping", () => {
  it("builds PostgreSQL payloads for users and token revocations", () => {
    const db = createPostgresBuilder();
    const createdAt = new Date("2026-05-06T00:00:00.000Z");
    const user = createUserInsert({
      createdAt,
      email: " USER_ACCOUNT ",
      id: "user-1",
      name: "User",
      passwordHash: "hash"
    });
    const userSql = db.insertInto("users").values(user).returningAll().compile();

    expect(userSql.sql).toContain('insert into "users"');
    expect(user).toMatchObject({
      email: "user_account",
      id: "user-1"
    });
    expect(mapUserRow(user)).toMatchObject({
      email: "user_account",
      id: "user-1"
    });
    expect(mapUserRow(user)).not.toHaveProperty("role");
  });
});

describe("jwt tokens", () => {
  it("creates, validates, and extracts HS256 tokens", () => {
    const jwt = new JwtTokenProvider({
      jwtExpirationMs: 60_000,
      jwtSecret
    });
    const user = {
      createdAt: new Date("2026-05-05T00:00:00.000Z"),
      email: "user_account",
      id: "user-1",
      name: "User",
      passwordHash: "hash"
    };
    const now = new Date();
    const token = jwt.createToken(user, now);
    const service = new Auth({
      authProvider: { authenticate: () => user, getUserById: () => user },
      jwt
    });

    expect(jwt.validateToken(token, new Date(now.getTime() + 1_000))).toBe("user-1");
    expect(service.authenticateBearer(token)?.userId).toBe("user-1");
    expect(service.logout(token)).toBe(true);
  });

  it("rejects weak JWT secrets", () => {
    expect(() => new JwtTokenProvider({ jwtSecret: "short" })).toThrow("JWT secret");
  });

  it("accepts a token signed by a previous secret during a rotation grace window", () => {
    const oldSecret = "old-secret-padded-out-to-thirty-two-bytes";
    const newSecret = "new-secret-padded-out-to-thirty-two-bytes";
    const oldJwt = new JwtTokenProvider({ jwtSecret: oldSecret });
    const token = oldJwt.createToken({ email: "user@example.com", id: "u1" });
    // A fresh provider with the new current secret + the old one in
    // the previousJwtSecrets array should still verify outstanding
    // tokens signed by the old secret.
    const rotated = new JwtTokenProvider({
      jwtSecret: newSecret,
      previousJwtSecrets: [oldSecret]
    });
    expect(rotated.validateToken(token)).toBe("u1");
    // New tokens always use the current secret — a provider with only
    // the new secret (no previous) verifies new tokens but rejects
    // old ones.
    const onlyNew = new JwtTokenProvider({ jwtSecret: newSecret });
    expect(onlyNew.validateToken(token)).toBeUndefined();
    const freshToken = rotated.createToken({ email: "user@example.com", id: "u1" });
    expect(onlyNew.validateToken(freshToken)).toBe("u1");
  });

  it("rejects weak entries in previousJwtSecrets too — every member meets the 32-byte minimum", () => {
    expect(() => new JwtTokenProvider({
      jwtSecret: "thirty-two-byte-secret-for-real-here",
      previousJwtSecrets: ["weak"]
    })).toThrow("Every previousJwtSecret");
  });

  it("extractExpiration returns undefined (not an Invalid Date) when claims.exp * 1000 would overflow the JS Date range", () => {
    const jwt = new JwtTokenProvider({
      jwtExpirationMs: 1e16,
      jwtSecret
    });
    const token = jwt.createToken({ email: "u@example.com", id: "u1" });
    const expiresAt = jwt.extractExpiration(token);
    expect(expiresAt, "claims.exp around 1e13 → *1000 = 1e16 > Date max (8.64e15) → Invalid Date; the fix returns undefined so callers fall through to their own fallback instead of holding an Invalid Date that crashes on .toISOString()").toBeUndefined();
  });

  it("extractExpiration returns a clean Date for a normal token", () => {
    const jwt = new JwtTokenProvider({
      jwtExpirationMs: 60_000,
      jwtSecret
    });
    const token = jwt.createToken({ email: "u@example.com", id: "u1" });
    const expiresAt = jwt.extractExpiration(token);
    expect(expiresAt).toBeInstanceOf(Date);
    expect(Number.isFinite(expiresAt?.getTime())).toBe(true);
  });

  it("Auth.authenticateBearer rejects a token whose exp claim overflows the Date range (instead of returning an Invalid-Date identity)", () => {
    const jwt = new JwtTokenProvider({
      jwtExpirationMs: 1e16,
      jwtSecret
    });
    const user = { email: "u@example.com", id: "u1" };
    const token = jwt.createToken(user);
    const service = new Auth({
      authProvider: { authenticate: () => user, getUserById: () => user },
      jwt
    });
    const identity = service.authenticateBearer(token);
    expect(identity, "exp ≈ 1e13 → *1000 = 1e16 > Date max → Invalid Date; the fix returns undefined instead of leaking an Invalid Date through AuthIdentity.expiresAt").toBeUndefined();
  });
});

describe("Auth registration and login", () => {
  it("registers a user and returns login tokens", () => {
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

    expect(registered.user).not.toHaveProperty("role");
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

describe("authorization helpers", () => {
  it("masks anonymous actors", () => {
    expect(currentActor(undefined)).toBe(anonymousActor);
  });

  it("extracts bearer tokens conservatively", () => {
    expect(extractBearerToken("Bearer token-1")).toBe("token-1");
    expect(extractBearerToken("Basic token-1")).toBeUndefined();
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
