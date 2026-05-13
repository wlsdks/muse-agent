import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { MuseDatabase, UserTable } from "@muse/db";
import { createRunId } from "@muse/shared";
import type { Insertable, Kysely, Selectable } from "kysely";

import { AuthError } from "./auth-error.js";
import { defaultJwtExpirationMs, JwtTokenProvider } from "./jwt.js";

export { AuthError } from "./auth-error.js";
export { JwtTokenProvider } from "./jwt.js";

export type Awaitable<T> = T | Promise<T>;

export interface User {
  readonly id: string;
  readonly email: string;
  readonly name: string;
  readonly passwordHash: string;
  readonly createdAt: Date;
}

export interface UserInput {
  readonly id?: string;
  readonly email: string;
  readonly name: string;
  readonly passwordHash: string;
  readonly createdAt?: Date;
  readonly updatedAt?: Date;
}

export interface AuthProvider {
  authenticate(email: string, password: string): User | undefined;
  getUserById(userId: string): User | undefined;
}

export interface AsyncAuthProvider {
  authenticate(email: string, password: string): Promise<User | undefined>;
  getUserById(userId: string): Promise<User | undefined>;
}

export interface UserStore {
  findByEmail(email: string): User | undefined;
  findById(id: string): User | undefined;
  save(user: UserInput): User;
  update(user: UserInput): User;
  existsByEmail(email: string): boolean;
  count(): number;
}

export interface AsyncUserStore {
  findByEmail(email: string): Promise<User | undefined>;
  findById(id: string): Promise<User | undefined>;
  save(user: UserInput): Promise<User>;
  update(user: UserInput): Promise<User>;
  existsByEmail(email: string): Promise<boolean>;
  count(): Promise<number>;
}

export interface AuthIdentity {
  readonly userId: string;
  readonly email: string;
  readonly tokenId: string;
  readonly expiresAt: Date;
  readonly accountId?: string;
}

export interface LoginResult {
  readonly token: string;
  readonly user: Omit<User, "passwordHash">;
  readonly expiresAt: Date;
}

/** Internal — return type of `MuseAuth.changePassword`. */
type PasswordChangeResult =
  | "changed"
  | "invalid_current_password"
  | "unsupported"
  | "user_not_found";

export interface AuthOptions {
  readonly authProvider: AuthProvider;
  readonly jwt: JwtTokenProvider;
  readonly userStore?: UserStore;
}

/** Internal — consumed by `AsyncAuth`'s constructor. */
interface AsyncAuthOptions {
  readonly authProvider: AsyncAuthProvider;
  readonly jwt: JwtTokenProvider;
  readonly userStore?: AsyncUserStore;
}

export interface MuseAuth {
  login(email: string, password: string): Awaitable<LoginResult | undefined>;
  register(input: { readonly email: string; readonly name: string; readonly password: string }): Awaitable<LoginResult>;
  changePassword(input: {
    readonly currentPassword: string;
    readonly newPassword: string;
    readonly userId: string;
  }): Awaitable<PasswordChangeResult>;
  getUserById(userId: string): Awaitable<Omit<User, "passwordHash"> | undefined>;
  authenticateBearer(token: string | undefined): Awaitable<AuthIdentity | undefined>;
  logout(token: string | undefined): Awaitable<boolean>;
}

export const anonymousActor = "anonymous";

const passwordHashVersion = "scrypt-v1";
const passwordKeyLength = 64;
const defaultMaxUsers = 10_000;

export class InMemoryUserStore implements UserStore {
  private readonly maxUsers: number;
  private readonly usersById = new Map<string, User>();
  private readonly usersByEmail = new Map<string, User>();

  constructor(maxUsers = defaultMaxUsers) {
    this.maxUsers = Math.max(1, maxUsers);
  }

  findByEmail(email: string): User | undefined {
    return this.usersByEmail.get(normalizeEmail(email));
  }

  findById(id: string): User | undefined {
    return this.usersById.get(id);
  }

  save(input: UserInput): User {
    const email = normalizeEmail(input.email);

    if (this.usersByEmail.has(email)) {
      throw new AuthError("USER_EXISTS", `User already exists: ${email}`);
    }

    const user = normalizeUserInput({ ...input, email });
    this.usersById.set(user.id, user);
    this.usersByEmail.set(email, user);
    this.evictOverflow();
    return user;
  }

  update(input: UserInput): User {
    const email = normalizeEmail(input.email);
    const user = normalizeUserInput({ ...input, email });
    const existing = this.usersById.get(user.id);

    if (existing && existing.email !== email) {
      this.usersByEmail.delete(existing.email);
    }

    const duplicate = this.usersByEmail.get(email);

    if (duplicate && duplicate.id !== user.id) {
      throw new AuthError("USER_EXISTS", `User already exists: ${email}`);
    }

    this.usersById.set(user.id, user);
    this.usersByEmail.set(email, user);
    this.evictOverflow();
    return user;
  }

  existsByEmail(email: string): boolean {
    return this.usersByEmail.has(normalizeEmail(email));
  }

  count(): number {
    return this.usersById.size;
  }

  private evictOverflow(): void {
    while (this.usersById.size > this.maxUsers) {
      const oldest = [...this.usersById.values()].sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())[0];

      if (!oldest) {
        return;
      }

      this.usersById.delete(oldest.id);
      this.usersByEmail.delete(oldest.email);
    }
  }
}

type UserRow = Selectable<UserTable>;
type UserInsert = Insertable<UserTable>;

export class KyselyUserStore implements AsyncUserStore {
  constructor(private readonly db: Kysely<MuseDatabase>) {}

  async findByEmail(email: string): Promise<User | undefined> {
    const row = await this.db
      .selectFrom("users")
      .selectAll()
      .where("email", "=", normalizeEmail(email))
      .executeTakeFirst();

    return row ? mapUserRow(row) : undefined;
  }

  async findById(id: string): Promise<User | undefined> {
    const row = await this.db.selectFrom("users").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? mapUserRow(row) : undefined;
  }

  async save(input: UserInput): Promise<User> {
    if (await this.existsByEmail(input.email)) {
      throw new AuthError("USER_EXISTS", `User already exists: ${normalizeEmail(input.email)}`);
    }

    const row = await this.db
      .insertInto("users")
      .values(createUserInsert(input))
      .returningAll()
      .executeTakeFirstOrThrow();

    return mapUserRow(row);
  }

  async update(input: UserInput): Promise<User> {
    const normalized = normalizeUserInput(input);
    const now = input.updatedAt ?? new Date();
    const duplicate = await this.findByEmail(normalized.email);

    if (duplicate && duplicate.id !== normalized.id) {
      throw new AuthError("USER_EXISTS", `User already exists: ${normalized.email}`);
    }

    const row = await this.db
      .insertInto("users")
      .values(createUserInsert({ ...input, id: normalized.id, email: normalized.email, updatedAt: now }))
      .onConflict((oc) =>
        oc.column("id").doUpdateSet({
          email: normalized.email,
          name: normalized.name,
          password_hash: normalized.passwordHash,
          updated_at: now
        })
      )
      .returningAll()
      .executeTakeFirstOrThrow();

    return mapUserRow(row);
  }

  async existsByEmail(email: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("users")
      .select("id")
      .where("email", "=", normalizeEmail(email))
      .executeTakeFirst();

    return Boolean(row);
  }

  async count(): Promise<number> {
    const row = await this.db
      .selectFrom("users")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .executeTakeFirst();

    return Number(row?.count ?? 0);
  }
}

export class PasswordHasher {
  hashPassword(password: string, salt = randomBytes(16).toString("base64url")): string {
    const hash = scryptSync(password, salt, passwordKeyLength).toString("base64url");
    return `${passwordHashVersion}:${salt}:${hash}`;
  }

  verify(password: string, passwordHash: string): boolean {
    const [version, salt, hash] = passwordHash.split(":");

    if (version !== passwordHashVersion || !salt || !hash) {
      return false;
    }

    const expected = Buffer.from(hash, "base64url");
    const actual = scryptSync(password, salt, expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }
}

export class DefaultAuthProvider implements AuthProvider {
  constructor(
    private readonly userStore: UserStore,
    private readonly passwordHasher = new PasswordHasher()
  ) {}

  authenticate(email: string, password: string): User | undefined {
    const user = this.userStore.findByEmail(email);
    return user && this.passwordHasher.verify(password, user.passwordHash) ? user : undefined;
  }

  getUserById(userId: string): User | undefined {
    return this.userStore.findById(userId);
  }

  hashPassword(password: string): string {
    return this.passwordHasher.hashPassword(password);
  }
}

export class KyselyAuthProvider implements AsyncAuthProvider {
  constructor(
    private readonly userStore: AsyncUserStore,
    private readonly passwordHasher = new PasswordHasher()
  ) {}

  async authenticate(email: string, password: string): Promise<User | undefined> {
    const user = await this.userStore.findByEmail(email);
    return user && this.passwordHasher.verify(password, user.passwordHash) ? user : undefined;
  }

  async getUserById(userId: string): Promise<User | undefined> {
    return this.userStore.findById(userId);
  }

  hashPassword(password: string): string {
    return this.passwordHasher.hashPassword(password);
  }
}

export class Auth implements MuseAuth {
  private readonly userStore?: UserStore;

  constructor(private readonly options: AuthOptions) {
    this.userStore = options.userStore;
  }

  login(email: string, password: string): LoginResult | undefined {
    const user = this.options.authProvider.authenticate(email, password);

    if (!user) {
      return undefined;
    }

    const token = this.options.jwt.createToken(user);
    const expiresAt = this.options.jwt.extractExpiration(token) ?? new Date(Date.now() + defaultJwtExpirationMs);
    return { expiresAt, token, user: publicUser(user) };
  }

  register(input: { readonly email: string; readonly name: string; readonly password: string }): LoginResult {
    if (!this.userStore) {
      throw new AuthError("REGISTRATION_DISABLED", "Registration requires a user store");
    }

    const provider = this.options.authProvider;
    const passwordHash =
      provider instanceof DefaultAuthProvider ? provider.hashPassword(input.password) : new PasswordHasher().hashPassword(input.password);
    const user = this.userStore.save({
      email: input.email,
      name: input.name,
      passwordHash
    });
    const token = this.options.jwt.createToken(user);
    const expiresAt = this.options.jwt.extractExpiration(token) ?? new Date(Date.now() + defaultJwtExpirationMs);
    return { expiresAt, token, user: publicUser(user) };
  }

  changePassword(input: {
    readonly currentPassword: string;
    readonly newPassword: string;
    readonly userId: string;
  }): PasswordChangeResult {
    if (!this.userStore || !(this.options.authProvider instanceof DefaultAuthProvider)) {
      return "unsupported";
    }

    const user = this.options.authProvider.getUserById(input.userId);

    if (!user) {
      return "user_not_found";
    }

    if (!this.options.authProvider.authenticate(user.email, input.currentPassword)) {
      return "invalid_current_password";
    }

    this.userStore.update({
      createdAt: user.createdAt,
      email: user.email,
      id: user.id,
      name: user.name,
      passwordHash: this.options.authProvider.hashPassword(input.newPassword)
    });
    return "changed";
  }

  getUserById(userId: string): Omit<User, "passwordHash"> | undefined {
    const user = this.options.authProvider.getUserById(userId);
    return user ? publicUser(user) : undefined;
  }

  authenticateBearer(token: string | undefined): AuthIdentity | undefined {
    if (!token) {
      return undefined;
    }

    const claims = this.options.jwt.parseToken(token);

    if (!claims) {
      return undefined;
    }

    return {
      accountId: claims.accountId,
      email: claims.email,
      expiresAt: new Date(claims.exp * 1_000),
      tokenId: claims.jti,
      userId: claims.sub
    };
  }

  logout(token: string | undefined): boolean {
    if (!token) {
      return false;
    }

    return Boolean(this.options.jwt.parseToken(token));
  }
}

export class AsyncAuth implements MuseAuth {
  private readonly userStore?: AsyncUserStore;

  constructor(private readonly options: AsyncAuthOptions) {
    this.userStore = options.userStore;
  }

  async login(email: string, password: string): Promise<LoginResult | undefined> {
    const user = await this.options.authProvider.authenticate(email, password);

    if (!user) {
      return undefined;
    }

    return this.createLoginResult(user);
  }

  async register(input: { readonly email: string; readonly name: string; readonly password: string }): Promise<LoginResult> {
    if (!this.userStore) {
      throw new AuthError("REGISTRATION_DISABLED", "Registration requires a user store");
    }

    const provider = this.options.authProvider;
    const passwordHash =
      provider instanceof KyselyAuthProvider ? provider.hashPassword(input.password) : new PasswordHasher().hashPassword(input.password);
    const user = await this.userStore.save({
      email: input.email,
      name: input.name,
      passwordHash
    });

    return this.createLoginResult(user);
  }

  async changePassword(input: {
    readonly currentPassword: string;
    readonly newPassword: string;
    readonly userId: string;
  }): Promise<PasswordChangeResult> {
    if (!this.userStore || !(this.options.authProvider instanceof KyselyAuthProvider)) {
      return "unsupported";
    }

    const user = await this.options.authProvider.getUserById(input.userId);

    if (!user) {
      return "user_not_found";
    }

    if (!(await this.options.authProvider.authenticate(user.email, input.currentPassword))) {
      return "invalid_current_password";
    }

    await this.userStore.update({
      createdAt: user.createdAt,
      email: user.email,
      id: user.id,
      name: user.name,
      passwordHash: this.options.authProvider.hashPassword(input.newPassword)
    });
    return "changed";
  }

  async getUserById(userId: string): Promise<Omit<User, "passwordHash"> | undefined> {
    const user = await this.options.authProvider.getUserById(userId);
    return user ? publicUser(user) : undefined;
  }

  async authenticateBearer(token: string | undefined): Promise<AuthIdentity | undefined> {
    if (!token) {
      return undefined;
    }

    const claims = this.options.jwt.parseToken(token);

    if (!claims) {
      return undefined;
    }

    return {
      accountId: claims.accountId,
      email: claims.email,
      expiresAt: new Date(claims.exp * 1_000),
      tokenId: claims.jti,
      userId: claims.sub
    };
  }

  async logout(token: string | undefined): Promise<boolean> {
    if (!token) {
      return false;
    }

    return Boolean(this.options.jwt.parseToken(token));
  }

  private createLoginResult(user: User): LoginResult {
    const token = this.options.jwt.createToken(user);
    const expiresAt = this.options.jwt.extractExpiration(token) ?? new Date(Date.now() + defaultJwtExpirationMs);
    return { expiresAt, token, user: publicUser(user) };
  }
}

export function currentActor(identity: AuthIdentity | undefined): string {
  return identity?.userId?.trim() || anonymousActor;
}

export function extractBearerToken(authorization: string | undefined): string | undefined {
  if (!authorization) {
    return undefined;
  }

  const [scheme, token] = authorization.split(/\s+/u);
  return scheme?.toLowerCase() === "bearer" && token ? token : undefined;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeUserInput(input: UserInput): User {
  const email = normalizeEmail(input.email);

  if (!email) {
    throw new AuthError("INVALID_USER", "User email must not be blank");
  }

  if (!input.name.trim()) {
    throw new AuthError("INVALID_USER", "User name must not be blank");
  }

  return {
    createdAt: input.createdAt ?? new Date(),
    email,
    id: input.id ?? createRunId("user"),
    name: input.name.trim(),
    passwordHash: input.passwordHash
  };
}

function publicUser(user: User): Omit<User, "passwordHash"> {
  return {
    createdAt: user.createdAt,
    email: user.email,
    id: user.id,
    name: user.name
  };
}

export function createUserInsert(input: UserInput): UserInsert {
  const user = normalizeUserInput(input);
  const updatedAt = input.updatedAt ?? user.createdAt;

  return {
    created_at: user.createdAt,
    email: user.email,
    id: user.id,
    name: user.name,
    password_hash: user.passwordHash,
    updated_at: updatedAt
  };
}

export function mapUserRow(row: UserRow): User {
  return {
    createdAt: toDate(row.created_at),
    email: row.email,
    id: row.id,
    name: row.name,
    passwordHash: row.password_hash
  };
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

