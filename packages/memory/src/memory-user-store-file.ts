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

import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { decryptMemoryEnvelope, encryptMemoryEnvelope, isEncryptedMemoryEnvelope } from "./memory-encryption.js";
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
import { appendFactHistory, collectFactSupersessions, mergeRecordTouchLast, normalizeMemoryKey, resolveForgetTarget, sanitizeUserMemoryValue } from "./memory-user-store.js";

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
  /**
   * Environment for the at-rest encryption key (`MUSE_MEMORY_KEY` or the per-host
   * fallback). Injectable so a test can pin/rotate the key. Defaults to
   * `process.env`. Encryption is OFF until `encryptAtRest()` runs once — a
   * plaintext store stays plaintext and is byte-unchanged.
   */
  readonly env?: NodeJS.ProcessEnv;
}

type StoredMemory = {
  readonly userId: string;
  readonly facts: Record<string, string>;
  readonly preferences: Record<string, string>;
  readonly recentTopics: readonly string[];
  readonly updatedAt: string;
  readonly userModel?: UserModel;
  readonly factHistory?: readonly { readonly key: string; readonly previousValue: string; readonly replacedAt: string; readonly kind?: "refine" | "contradict"; readonly scope?: "fact" | "preference" }[];
};

type StoredFile = { readonly version: 1; readonly users: Record<string, StoredMemory> };

function defaultPath(): string {
  return join(homedir(), ".muse", "user-memory.json");
}

function emptyFile(): StoredFile {
  return { users: {}, version: 1 };
}

function coerceStoredFile(parsed: unknown): StoredFile {
  if (!parsed || typeof parsed !== "object") {
    return emptyFile();
  }
  const root = parsed as { version?: number; users?: Record<string, StoredMemory> };
  if (root.version !== 1 || !root.users) {
    return emptyFile();
  }
  return { users: root.users, version: 1 };
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
      ? { factHistory: memory.factHistory.map((entry) => ({ key: entry.key, previousValue: entry.previousValue, replacedAt: entry.replacedAt.toISOString(), ...(entry.kind ? { kind: entry.kind } : {}), ...(entry.scope === "preference" ? { scope: entry.scope } : {}) })) }
      : {})
  };
}

// A stored date that is missing / empty / corrupt (a hand-edited memory file, a
// pre-`updatedAt` legacy entry, a bad backup/sync) would become an Invalid Date,
// and the very next write — `memoryToStored` calls `.toISOString()` — would throw
// and crash EVERY future memory mutation, silently losing the user's updates. The
// memory file is the user's own (`Tell it everything`), so degrade to the epoch
// sentinel instead of throwing; a valid date is untouched (no false correction).
function parseStoredDate(value: unknown): Date {
  const date = new Date(value as string | number | Date);
  return Number.isFinite(date.getTime()) ? date : new Date(0);
}

function storedToMemory(stored: StoredMemory): UserMemory {
  return {
    facts: { ...stored.facts },
    preferences: { ...stored.preferences },
    // Tolerant like parseStoredDate below: a hand-edited / legacy entry may
    // lack recentTopics entirely — that must not crash every read of the store.
    recentTopics: [...(stored.recentTopics ?? [])],
    updatedAt: parseStoredDate(stored.updatedAt),
    userId: stored.userId,
    ...(stored.userModel ? { userModel: stored.userModel } : {}),
    ...(stored.factHistory
      ? { factHistory: stored.factHistory.map((entry): FactSupersession => ({ key: entry.key, previousValue: entry.previousValue, replacedAt: parseStoredDate(entry.replacedAt), ...(entry.kind === "refine" || entry.kind === "contradict" ? { kind: entry.kind } : {}), ...(entry.scope === "preference" ? { scope: entry.scope } : {}) })) }
      : {})
  };
}

/**
 * The orphaned legacy bucket for `userId`, when one exists: the "default"
 * entry counts as the resolved user's memory ONLY when that user has no
 * bucket of their own (and is not "default" itself).
 */
function legacyDefaultEntry(data: StoredFile, userId: string): StoredMemory | undefined {
  // A slot-qualified identity ("user@work") is a deliberate sub-profile — it
  // starts empty by design and never inherits the legacy base bucket.
  if (userId === "default" || userId.includes("@") || data.users[userId] !== undefined) {
    return undefined;
  }
  return data.users["default"];
}

export class FileUserMemoryStore implements UserMemoryStore {
  private static readonly writeQueues = new Map<string, Promise<unknown>>();
  private readonly file: string;
  private readonly now: () => Date;
  private readonly env: NodeJS.ProcessEnv;

  constructor(options: FileUserMemoryStoreOptions = {}) {
    this.file = options.file ?? defaultPath();
    this.now = options.now ?? (() => new Date());
    this.env = options.env ?? process.env;
  }

  async findByUserId(userId: string): Promise<UserMemory | undefined> {
    const { file: data } = await this.read();
    const entry = data.users[userId];
    if (entry) {
      // The bucket KEY is the identity; a legacy entry's stored userId may be
      // absent or drifted, so the requested key is authoritative.
      return { ...storedToMemory(entry), userId };
    }
    // Legacy-bucket healing: the session user id resolves from
    // MUSE_USER_ID ?? USER ?? "default", so a context without USER (an old
    // daemon, an early version) wrote the SAME human's facts under "default"
    // while today's session reads e.g. "stark" — and "learns you" looked
    // empty on a box with real history. This is a single-user local store:
    // when the resolved bucket doesn't exist, the orphaned "default" bucket
    // is that user's memory. Reads surface it; the first write migrates it
    // (see patch). A deliberately-named coexisting bucket is never touched —
    // the fallback only fires when the resolved bucket is ABSENT.
    const legacy = legacyDefaultEntry(data, userId);
    return legacy ? { ...storedToMemory(legacy), userId } : undefined;
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
    return this.patch(userId, (existing) => {
      const factHistory = appendFactHistory(
        existing.factHistory,
        collectFactSupersessions(existing.preferences, { [key]: safe }, this.now(), "preference")
      );
      return {
        ...existing,
        preferences: mergeRecordTouchLast(existing.preferences, { [key]: safe }),
        ...(factHistory ? { factHistory } : {})
      };
    });
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

  async forget(userId: string, rawKey: string, kind?: "fact" | "preference"): Promise<boolean> {
    const existing = await this.findByUserId(userId);
    if (!existing) return false;
    const target = resolveForgetTarget(existing, rawKey, kind);
    if (!target) {
      return false;
    }
    const { key, dropFact, dropPref } = target;
    await this.patch(userId, (current) => {
      const { [key]: _f, ...factsWithout } = current.facts;
      const { [key]: _p, ...prefsWithout } = current.preferences;
      return { ...current, facts: dropFact ? factsWithout : current.facts, preferences: dropPref ? prefsWithout : current.preferences };
    });
    return true;
  }

  async deleteByUserId(userId: string): Promise<boolean> {
    return this.serializeWrite(async () => this.withFileLock(async () => {
      const { file: data, encrypted } = await this.read();
      if (!data.users[userId]) {
        return false;
      }
      const { [userId]: _dropped, ...rest } = data.users;
      await this.write({ ...data, users: rest }, encrypted);
      return true;
    }));
  }

  private async patch(userId: string, mutator: (existing: UserMemory) => UserMemory): Promise<UserMemory> {
    return this.serializeWrite(async () => this.withFileLock(async () => {
      const { file: data, encrypted } = await this.read();
      const existingStored = data.users[userId];
      // One-time convergence of the orphaned legacy "default" bucket (see
      // findByUserId): the first write under the resolved user adopts the
      // legacy data as its baseline and drops the "default" key in the same
      // write, so the store converges to one bucket per human.
      const legacy = existingStored === undefined ? legacyDefaultEntry(data, userId) : undefined;
      const baseline: UserMemory = existingStored
        ? storedToMemory(existingStored)
        : legacy
          ? { ...storedToMemory(legacy), userId }
          : {
              facts: {},
              preferences: {},
              recentTopics: [],
              updatedAt: this.now(),
              userId
            };
      const updated: UserMemory = { ...mutator(baseline), updatedAt: this.now() };
      const users: Record<string, StoredMemory> = { ...data.users, [userId]: memoryToStored(updated) };
      if (legacy) {
        delete users["default"];
      }
      const next: StoredFile = { ...data, users };
      await this.write(next, encrypted);
      return updated;
    }));
  }

  private async serializeWrite<T>(fn: () => Promise<T>): Promise<T> {
    const prior = FileUserMemoryStore.writeQueues.get(this.file) ?? Promise.resolve();
    const next = prior.then(fn, fn);
    FileUserMemoryStore.writeQueues.set(this.file, next.catch(() => undefined));
    return next;
  }

  // Returns the parsed file AND whether it was encrypted at rest, so a write can
  // PRESERVE the format (an encrypted store stays encrypted) without a side flag.
  // NEVER writes — the only write from a read path was the corrupt-PLAINTEXT
  // quarantine; an encrypted store with a WRONG key THROWS (fail-closed) instead,
  // because quarantining/emptying its ciphertext would lose the confided life.
  private async read(): Promise<{ readonly file: StoredFile; readonly encrypted: boolean }> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (cause) {
      if (cause instanceof Error && (cause as NodeJS.ErrnoException).code === "ENOENT") {
        return { encrypted: false, file: emptyFile() };
      }
      throw cause;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Non-JSON ⇒ corrupt PLAINTEXT (an encrypted store is a valid JSON
      // envelope, so it never lands here). Quarantine + degrade to empty as
      // before — a corrupt plaintext memory must not crash EVERY run.
      await this.quarantineCorrupt();
      return { encrypted: false, file: emptyFile() };
    }
    if (isEncryptedMemoryEnvelope(parsed)) {
      const plaintext = decryptMemoryEnvelope(parsed, this.env); // THROWS on wrong key / tamper — fail closed
      let inner: unknown;
      try {
        inner = JSON.parse(plaintext);
      } catch {
        throw new Error("user-memory decrypted but its contents are not valid JSON — refusing to overwrite; restore the .plaintext-backup file.");
      }
      return { encrypted: true, file: coerceStoredFile(inner) };
    }
    return { encrypted: false, file: coerceStoredFile(parsed) };
  }

  private async quarantineCorrupt(): Promise<void> {
    try {
      await rename(this.file, `${this.file}.corrupt-${Date.now().toString()}`);
    } catch {
      // best-effort — read degrades to empty either way
    }
  }

  private async write(data: StoredFile, encrypted: boolean): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const serialized = JSON.stringify(data, null, 2);
    const payload = encrypted
      ? `${JSON.stringify(encryptMemoryEnvelope(serialized, this.env), null, 2)}\n`
      : `${serialized}\n`;
    const tmp = `${this.file}.tmp-${process.pid.toString()}-${Date.now().toString()}`;
    await writeFile(tmp, payload, { mode: 0o600 });
    await rename(tmp, this.file);
  }

  /**
   * Whether the at-rest store is currently encrypted — detects the envelope
   * FORMAT without decrypting, so `muse memory encryption-status` works even when
   * the key is wrong/absent (a wrong key shouldn't hide that the file IS
   * encrypted). A missing/empty/plaintext file is "not encrypted".
   */
  async isEncryptedAtRest(): Promise<boolean> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch {
      return false;
    }
    try {
      return isEncryptedMemoryEnvelope(JSON.parse(raw));
    } catch {
      return false;
    }
  }

  /**
   * One-shot migration to encryption-at-rest: snapshot the plaintext to a
   * `.plaintext-backup-<ts>` (recovery if the key derivation later changes), then
   * rewrite the store encrypted. Cross-process LOCKED (an O_EXCL lockfile) so a
   * concurrent daemon can't race the migration, AND in-process serialized. After
   * this, ordinary writes preserve the encrypted format. Idempotent: a no-op when
   * already encrypted.
   */
  async encryptAtRest(): Promise<{ readonly alreadyEncrypted: boolean; readonly backupPath?: string }> {
    return this.serializeWrite(async () => this.withFileLock(async () => {
      const { file: data, encrypted } = await this.read();
      if (encrypted) {
        return { alreadyEncrypted: true };
      }
      const backupPath = `${this.file}.plaintext-backup-${this.now().toISOString().replace(/[:.]/gu, "-")}`;
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(backupPath, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
      await this.write(data, true);
      return { alreadyEncrypted: false, backupPath };
    }));
  }

  /**
   * Reverse the migration — rewrite the store as plaintext. Reads (and so
   * decrypts) first, which THROWS fail-closed if the key is wrong, so a wrong-key
   * decrypt can never silently emit an empty plaintext file. Cross-process locked.
   */
  async decryptAtRest(): Promise<{ readonly alreadyPlaintext: boolean }> {
    return this.serializeWrite(async () => this.withFileLock(async () => {
      const { file: data, encrypted } = await this.read();
      if (!encrypted) {
        return { alreadyPlaintext: true };
      }
      await this.write(data, false);
      return { alreadyPlaintext: false };
    }));
  }

  // EVERY mutation (upsert / delete / encrypt / decrypt) runs under ONE
  // cross-process O_EXCL lock so a concurrent ordinary write in another process
  // (e.g. the daemon's auto-extract) cannot race a migration's read-modify-write
  // and lose a fact or the encryption (last-rename-wins). The in-process
  // serializeWrite still orders same-process writes so they don't busy-spin on
  // the file lock. A lock older than LOCK_STALE_MS (a write whose process died
  // mid-flight) is STOLEN so a crash can't block writes forever; reads never
  // lock (the atomic rename keeps the file consistent for a concurrent reader).
  private async withFileLock<T>(fn: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.file), { recursive: true });
    const lockPath = `${this.file}.lock`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    for (let attempt = 0; handle === undefined; attempt += 1) {
      try {
        handle = await open(lockPath, "wx");
      } catch (cause) {
        if (!(cause instanceof Error) || (cause as NodeJS.ErrnoException).code !== "EEXIST") {
          throw cause;
        }
        if (await lockIsStale(lockPath)) {
          await unlink(lockPath).catch(() => undefined); // steal a dead holder's lock
          continue;
        }
        if (attempt >= LOCK_MAX_ATTEMPTS) {
          throw new Error("user-memory is locked by another write in progress — retry shortly", { cause });
        }
        await new Promise<void>((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
      }
    }
    try {
      return await fn();
    } finally {
      await handle.close().catch(() => undefined);
      await unlink(lockPath).catch(() => undefined);
    }
  }
}

const LOCK_STALE_MS = 30_000;
const LOCK_RETRY_MS = 50;
const LOCK_MAX_ATTEMPTS = 60; // ~3s before giving up on a live lock holder

async function lockIsStale(lockPath: string): Promise<boolean> {
  try {
    return Date.now() - (await stat(lockPath)).mtimeMs > LOCK_STALE_MS;
  } catch {
    return true; // vanished between the EEXIST and the stat — treat as stealable
  }
}
