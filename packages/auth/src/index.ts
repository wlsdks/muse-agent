import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

import { AuthError } from "./auth-error.js";
import { defaultJwtExpirationMs, JwtTokenProvider } from "./jwt.js";
import type {
  AsyncUserStore,
  User,
  UserStore
} from "./user-stores.js";

export { AuthError } from "./auth-error.js";
export { JwtTokenProvider } from "./jwt.js";
export { parseJwtRotationState, type JwtPreviousSecret, type JwtRotationState } from "./jwt-rotation-state.js";
export {
  InMemoryUserStore,
  KyselyUserStore,
  createUserInsert,
  mapUserRow,
  normalizeEmail,
  type AsyncUserStore,
  type User,
  type UserInput,
  type UserStore
} from "./user-stores.js";

export type Awaitable<T> = T | Promise<T>;

export interface AuthProvider {
  authenticate(email: string, password: string): User | undefined;
  getUserById(userId: string): User | undefined;
}

export interface AsyncAuthProvider {
  authenticate(email: string, password: string): Promise<User | undefined>;
  getUserById(userId: string): Promise<User | undefined>;
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
    // Node's base64url decoder is lenient and silently drops invalid
    // chars; a corrupt `hash` segment can decode to an empty (or
    // wrong-length) Buffer, then `scryptSync(_, _, 0)` returns empty
    // and `timingSafeEqual(empty, empty)` is true — password bypass
    // with ANY input. Pin to the exact scrypt output length.
    if (expected.length !== passwordKeyLength) {
      return false;
    }

    const actual = scryptSync(password, salt, expected.length);
    return timingSafeEqual(actual, expected);
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

    return buildLoginResult(this.options.jwt, user);
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
    return buildLoginResult(this.options.jwt, user);
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
    return identityFromToken(this.options.jwt, token);
  }

  logout(token: string | undefined): boolean {
    return isValidLogoutToken(this.options.jwt, token);
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
    return identityFromToken(this.options.jwt, token);
  }

  async logout(token: string | undefined): Promise<boolean> {
    return isValidLogoutToken(this.options.jwt, token);
  }

  private createLoginResult(user: User): LoginResult {
    return buildLoginResult(this.options.jwt, user);
  }
}

export function currentActor(identity: AuthIdentity | undefined): string {
  return identity?.userId?.trim() || anonymousActor;
}

export function extractBearerToken(authorization: string | undefined): string | undefined {
  if (!authorization) {
    return undefined;
  }

  // Some reverse proxies prepend whitespace; without trimming,
  // split(/\s+/u) on "  Bearer abc" puts scheme on "" and the
  // header is wrongly rejected.
  const trimmed = authorization.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const [scheme, token] = trimmed.split(/\s+/u);
  return scheme?.toLowerCase() === "bearer" && token ? token : undefined;
}

function publicUser(user: User): Omit<User, "passwordHash"> {
  return {
    createdAt: user.createdAt,
    email: user.email,
    id: user.id,
    name: user.name
  };
}

// Shared await-free core for Auth/AsyncAuth, which differ ONLY in the store await.
function buildLoginResult(jwt: JwtTokenProvider, user: User): LoginResult {
  const token = jwt.createToken(user);
  const expiresAt = jwt.extractExpiration(token) ?? new Date(Date.now() + defaultJwtExpirationMs);
  return { expiresAt, token, user: publicUser(user) };
}

function identityFromToken(jwt: JwtTokenProvider, token: string | undefined): AuthIdentity | undefined {
  if (!token) {
    return undefined;
  }

  const claims = jwt.parseToken(token);

  if (!claims) {
    return undefined;
  }

  const expiresAt = new Date(claims.exp * 1_000);
  if (!Number.isFinite(expiresAt.getTime())) {
    return undefined;
  }

  return {
    accountId: claims.accountId,
    email: claims.email,
    expiresAt,
    tokenId: claims.jti,
    userId: claims.sub
  };
}

function isValidLogoutToken(jwt: JwtTokenProvider, token: string | undefined): boolean {
  if (!token) {
    return false;
  }

  return Boolean(jwt.parseToken(token));
}
