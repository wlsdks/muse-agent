/**
 * `UserStore` implementations + row-mapping helpers. Lives in a
 * leaf module so `./index.ts` can shrink to the authentication
 * orchestration layer (Auth + AsyncAuth + password hashing).
 * Public exports re-export through `./index.ts` so external
 * imports stay byte-identical.
 *
 * `normalizeUserInput` and `toDate` are private to this module —
 * both stores need them, no external caller does.
 *
 * `normalizeEmail`, `createUserInsert`, `mapUserRow` are exported
 * here directly because they're called from outside the auth
 * package (server bootstrapping + tests).
 */

import type { MuseDatabase, UserTable } from "@muse/db";
import { createRunId, isErrorLike, toDate } from "@muse/shared";
import type { Insertable, Kysely, Selectable } from "kysely";

import { AuthError } from "./auth-error.js";

const defaultMaxUsers = 10_000;
const postgresUniqueViolation = "23505";

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

export class InMemoryUserStore implements UserStore {
  private readonly maxUsers: number;
  private readonly usersById = new Map<string, User>();
  private readonly usersByEmail = new Map<string, User>();

  constructor(maxUsers = defaultMaxUsers) {
    if (!Number.isSafeInteger(maxUsers) || maxUsers < 1) {
      throw new RangeError("maxUsers must be a positive safe integer");
    }
    this.maxUsers = maxUsers;
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

    // Validate BEFORE mutating: deleting the old email key first
    // meant a failed email-change (target already taken) left the
    // user in usersById but unreachable via findByEmail — a silent
    // lock-out of their own account.
    const duplicate = this.usersByEmail.get(email);

    if (duplicate && duplicate.id !== user.id) {
      throw new AuthError("USER_EXISTS", `User already exists: ${email}`);
    }

    if (existing && existing.email !== email) {
      this.usersByEmail.delete(existing.email);
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
    const user = createUserInsert(input);
    const row = await runUserWrite(user.email, () => this.db
      .insertInto("users")
      .values(user)
      .onConflict((oc) => oc.column("email").doNothing())
      .returningAll()
      .executeTakeFirst());

    if (!row) {
      throw new AuthError("USER_EXISTS", `User already exists: ${user.email}`);
    }

    return mapUserRow(row);
  }

  async update(input: UserInput): Promise<User> {
    const normalized = normalizeUserInput(input);
    const now = input.updatedAt ?? new Date();
    const duplicate = await this.findByEmail(normalized.email);

    if (duplicate && duplicate.id !== normalized.id) {
      throw new AuthError("USER_EXISTS", `User already exists: ${normalized.email}`);
    }

    const row = await runUserWrite(normalized.email, () => this.db
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
      .executeTakeFirstOrThrow());

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

  if (!input.passwordHash.trim()) {
    throw new AuthError("INVALID_USER", "User passwordHash must not be blank");
  }

  return {
    createdAt: input.createdAt ?? new Date(),
    email,
    id: input.id ?? createRunId("user"),
    name: input.name.trim(),
    passwordHash: input.passwordHash
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

async function runUserWrite<T>(email: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isErrorLike(error) && "code" in error && String(error.code) === postgresUniqueViolation) {
      throw new AuthError("USER_EXISTS", `User already exists: ${email}`);
    }
    throw error;
  }
}
