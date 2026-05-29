/**
 * `FileUserMemoryStore` — JSON-file-backed UserMemoryStore for the
 * JARVIS daily-driver path that doesn't run Postgres. Auto-extract
 * + REPL writes facts/preferences here; the file is the
 * source-of-truth so a new shell session starts knowing the user.
 *
 * On-disk shape: a single JSON object keyed by userId, mirroring the
 * `UserMemory` interface. Atomic tmp+rename writes; the parent
 * directory is created on demand; mode 0o600 so the credential-ish
 * facts (api keys, tokens, etc.) the user might confide stay
 * private even on shared boxes.
 *
 * Drop-in replacement for `InMemoryUserMemoryStore` — same surface,
 * just persists. Autoconfigure prefers Kysely when a DB is wired,
 * this file store otherwise, and falls back to in-memory only when
 * the user explicitly disables persistence.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  EMPTY_USER_MODEL,
  removeUserModelSlot as removeSlot,
  upsertUserModelSlot as upsertSlot,
  type FactSupersession,
  type UserMemory,
  type UserMemoryStore,
  type UserModel,
  type UserModelSlot
} from "./index.js";
import { appendFactHistory, collectFactSupersessions, mergeRecordTouchLast, normalizeMemoryKey, sanitizeUserMemoryValue } from "./memory-user-store.js";

export interface FileUserMemoryStoreOptions {
  /**
   * Absolute path of the JSON file. Defaults to
   * `~/.muse/user-memory.json`. The file format is
   * `{ "<userId>": UserMemory, ... }` so multiple identities can
   * coexist in one store (e.g. a personal user + a household
   * shared profile).
   */
  readonly file?: string;
  /** Injectable clock for tests. */
  readonly now?: () => Date;
}

type StoredMemory = {
  readonly userId: string;
  readonly facts: Record<string, string>;
  readonly preferences: Record<string, string>;
  readonly recentTopics: readonly string[];
  readonly updatedAt: string;
  readonly userModel?: UserModel;
  readonly factHistory?: readonly { readonly key: string; readonly previousValue: string; readonly replacedAt: string }[];
};

type StoredFile = { readonly version: 1; readonly users: Record<string, StoredMemory> };

function defaultPath(): string {
  return join(homedir(), ".muse", "user-memory.json");
}

function emptyFile(): StoredFile {
  return { users: {}, version: 1 };
}

function memoryToStored(memory: UserMemory): StoredMemory {
  return {
    facts: { ...memory.facts },
    preferences: { ...memory.preferences },
    recentTopics: [...memory.recentTopics],
    updatedAt: memory.updatedAt.toISOString(),
    userId: memory.userId,
    ...(memory.userModel ? { userModel: memory.userModel } : {}),
    ...(memory.factHistory
      ? { factHistory: memory.factHistory.map((entry) => ({ key: entry.key, previousValue: entry.previousValue, replacedAt: entry.replacedAt.toISOString() })) }
      : {})
  };
}

function storedToMemory(stored: StoredMemory): UserMemory {
  return {
    facts: { ...stored.facts },
    preferences: { ...stored.preferences },
    recentTopics: [...stored.recentTopics],
    updatedAt: new Date(stored.updatedAt),
    userId: stored.userId,
    ...(stored.userModel ? { userModel: stored.userModel } : {}),
    ...(stored.factHistory
      ? { factHistory: stored.factHistory.map((entry): FactSupersession => ({ key: entry.key, previousValue: entry.previousValue, replacedAt: new Date(entry.replacedAt) })) }
      : {})
  };
}

export class FileUserMemoryStore implements UserMemoryStore {
  private static readonly writeQueues = new Map<string, Promise<unknown>>();
  private readonly file: string;
  private readonly now: () => Date;

  constructor(options: FileUserMemoryStoreOptions = {}) {
    this.file = options.file ?? defaultPath();
    this.now = options.now ?? (() => new Date());
  }

  async findByUserId(userId: string): Promise<UserMemory | undefined> {
    const data = await this.read();
    const entry = data.users[userId];
    return entry ? storedToMemory(entry) : undefined;
  }

  async upsertFact(userId: string, rawKey: string, value: string): Promise<UserMemory> {
    const key = normalizeMemoryKey(rawKey);
    const safe = sanitizeUserMemoryValue(value);
    return this.patch(userId, (existing) => {
      const factHistory = appendFactHistory(
        existing.factHistory,
        collectFactSupersessions(existing.facts, { [key]: safe }, this.now())
      );
      return {
        ...existing,
        facts: mergeRecordTouchLast(existing.facts, { [key]: safe }),
        ...(factHistory ? { factHistory } : {})
      };
    });
  }

  async upsertPreference(userId: string, rawKey: string, value: string): Promise<UserMemory> {
    const key = normalizeMemoryKey(rawKey);
    const safe = sanitizeUserMemoryValue(value);
    return this.patch(userId, (existing) => ({
      ...existing,
      preferences: mergeRecordTouchLast(existing.preferences, { [key]: safe })
    }));
  }

  // Typed user-model slots — the local-first write path. The slots
  // round-trip through this file store already; these add the missing
  // mutators so the local JARVIS can actually accrue a typed model
  // (preferences / schedule / vetoes / goals) that the persona renders.
  async upsertUserModelSlot(userId: string, slot: UserModelSlot): Promise<UserMemory> {
    return this.patch(userId, (existing) => ({
      ...existing,
      userModel: upsertSlot(existing.userModel ?? EMPTY_USER_MODEL, slot)
    }));
  }

  async removeUserModelSlot(userId: string, id: string): Promise<UserMemory> {
    return this.patch(userId, (existing) => ({
      ...existing,
      userModel: removeSlot(existing.userModel ?? EMPTY_USER_MODEL, id)
    }));
  }

  async forget(userId: string, rawKey: string): Promise<boolean> {
    const existing = await this.findByUserId(userId);
    if (!existing) return false;
    // Exact stored key first; else the normalized form, so "Home City" can
    // forget the canonicalized "home_city" entry written by upsertFact.
    const key = (rawKey in existing.facts || rawKey in existing.preferences) ? rawKey : normalizeMemoryKey(rawKey);
    if (!(key in existing.facts) && !(key in existing.preferences)) {
      return false;
    }
    await this.patch(userId, (current) => {
      const { [key]: _f, ...facts } = current.facts;
      const { [key]: _p, ...preferences } = current.preferences;
      return { ...current, facts, preferences };
    });
    return true;
  }

  async deleteByUserId(userId: string): Promise<boolean> {
    return this.serializeWrite(async () => {
      const data = await this.read();
      if (!data.users[userId]) {
        return false;
      }
      const { [userId]: _dropped, ...rest } = data.users;
      await this.write({ ...data, users: rest });
      return true;
    });
  }

  private async patch(userId: string, mutator: (existing: UserMemory) => UserMemory): Promise<UserMemory> {
    return this.serializeWrite(async () => {
      const data = await this.read();
      const existingStored = data.users[userId];
      const baseline: UserMemory = existingStored
        ? storedToMemory(existingStored)
        : {
            facts: {},
            preferences: {},
            recentTopics: [],
            updatedAt: this.now(),
            userId
          };
      const updated: UserMemory = { ...mutator(baseline), updatedAt: this.now() };
      const next: StoredFile = {
        ...data,
        users: { ...data.users, [userId]: memoryToStored(updated) }
      };
      await this.write(next);
      return updated;
    });
  }

  private async serializeWrite<T>(fn: () => Promise<T>): Promise<T> {
    const prior = FileUserMemoryStore.writeQueues.get(this.file) ?? Promise.resolve();
    const next = prior.then(fn, fn);
    FileUserMemoryStore.writeQueues.set(this.file, next.catch(() => undefined));
    return next;
  }

  private async read(): Promise<StoredFile> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (cause) {
      if (cause instanceof Error && (cause as NodeJS.ErrnoException).code === "ENOENT") {
        return emptyFile();
      }
      throw cause;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A corrupt user-memory.json would otherwise crash EVERY run — the
      // store is read to inject memory into the system prompt. Quarantine
      // the bad file and degrade to empty, matching the personal stores.
      await this.quarantineCorrupt();
      return emptyFile();
    }
    if (!parsed || typeof parsed !== "object") {
      return emptyFile();
    }
    const root = parsed as { version?: number; users?: Record<string, StoredMemory> };
    if (root.version !== 1 || !root.users) {
      return emptyFile();
    }
    return { users: root.users, version: 1 };
  }

  private async quarantineCorrupt(): Promise<void> {
    try {
      await rename(this.file, `${this.file}.corrupt-${Date.now().toString()}`);
    } catch {
      // best-effort — read degrades to empty either way
    }
  }

  private async write(data: StoredFile): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid.toString()}-${Date.now().toString()}`;
    await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.file);
  }
}
