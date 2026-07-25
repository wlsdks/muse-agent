import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

import { atomicWriteFile } from "./atomic-file-store.js";

export type LocalModelExecutionRole = "foreground" | "background";
export type LocalModelExecutionLeaseErrorCode =
  | "QUEUE_TIMEOUT"
  | "REQUEST_ABORTED"
  | "STATE_UNAVAILABLE"
  | "LEASE_LOST";
export type ProcessLiveness = "alive" | "dead" | "unknown";

const VERSION = 1;
const RECORD_KEYS = ["createdAtMs", "pid", "role", "sequence", "token", "version"] as const;
const GUARD_KEYS = ["createdAtMs", "pid", "token", "version"] as const;
const GUARD_TICKET_KEYS = ["createdAtMs", "pid", "sequence", "token", "version"] as const;
const SEQUENCE_KEYS = ["nextSequence", "version"] as const;

interface LeaseRecord {
  readonly version: 1;
  readonly token: string;
  readonly pid: number;
  readonly role: LocalModelExecutionRole;
  readonly sequence: number;
  readonly createdAtMs: number;
}

interface GuardRecord {
  readonly version: 1;
  readonly token: string;
  readonly pid: number;
  readonly createdAtMs: number;
}

interface GuardTicketRecord extends GuardRecord {
  readonly sequence: number;
}

interface SequenceRecord {
  readonly version: 1;
  readonly nextSequence: number;
}

export interface LocalModelExecutionLeaseOptions {
  readonly root?: string;
  readonly pid?: number;
  readonly foregroundWaitMs?: number;
  readonly backgroundWaitMs?: number;
  readonly pollMs?: number;
  readonly now?: () => number;
  readonly token?: () => string;
  readonly processLiveness?: (pid: number) => ProcessLiveness;
  readonly wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Deterministic concurrency-test seam; production leaves this unset. */
  readonly onGuardStage?: (
    stage: "choosing-published" | "ticket-published" | "entered",
    token: string
  ) => void | Promise<void>;
}

export interface LocalModelExecutionLease {
  /** Immutable authority identity persisted in active.json for fencing. */
  readonly createdAtMs: number;
  readonly pid: number;
  readonly role: LocalModelExecutionRole;
  readonly sequence: number;
  readonly token: string;
  readonly waitMs: number;
  validate(): Promise<boolean>;
  hasForegroundWaiter(signal?: AbortSignal): Promise<boolean>;
  release(): Promise<void>;
}

export class LocalModelExecutionLeaseError extends Error {
  readonly code: LocalModelExecutionLeaseErrorCode;

  constructor(code: LocalModelExecutionLeaseErrorCode, message: string) {
    super(message);
    this.name = "LocalModelExecutionLeaseError";
    this.code = code;
  }
}

export const DEFAULT_LOCAL_MODEL_FOREGROUND_WAIT_MS = 15_000;
export const DEFAULT_LOCAL_MODEL_BACKGROUND_WAIT_MS = 1_000;
export const DEFAULT_LOCAL_MODEL_POLL_MS = 25;

const MAX_FOREGROUND_WAIT_MS = 120_000;
const MAX_BACKGROUND_WAIT_MS = 15_000;
const MAX_POLL_MS = 1_000;
const MIN_POLL_MS = 5;

function integer(value: number | undefined, fallback: number, min: number, max: number): number {
  return Number.isSafeInteger(value) && value! >= min && value! <= max ? value! : fallback;
}

export function resolveLocalModelExecutionLeaseRoot(
  env: Readonly<Record<string, string | undefined>> = process.env
): string {
  const override = env.MUSE_CROSS_PROCESS_MODEL_LEASE_ROOT?.trim();
  if (override !== undefined && override.length > 0) {
    if (!isAbsolute(override) || override.includes("\0")) {
      throw new LocalModelExecutionLeaseError(
        "STATE_UNAVAILABLE",
        "local model execution lease state is unavailable"
      );
    }
    return override;
  }
  const home = env.HOME?.trim() || homedir();
  if (!isAbsolute(home) || home.includes("\0")) throw stateError();
  return join(home, ".muse", "model-execution-lease");
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,128}$/u.test(value);
}

function parseGuard(value: unknown): GuardRecord | undefined {
  if (!isRecord(value) || !exactKeys(value, GUARD_KEYS)) return undefined;
  if (value.version !== VERSION || !validToken(value.token) || !positiveSafeInteger(value.pid)) return undefined;
  if (!nonNegativeSafeInteger(value.createdAtMs)) return undefined;
  return value as unknown as GuardRecord;
}

function parseGuardTicket(value: unknown): GuardTicketRecord | undefined {
  if (!isRecord(value) || !exactKeys(value, GUARD_TICKET_KEYS)) return undefined;
  if (value.version !== VERSION || !validToken(value.token) || !positiveSafeInteger(value.pid)) return undefined;
  if (!positiveSafeInteger(value.sequence) || !nonNegativeSafeInteger(value.createdAtMs)) return undefined;
  return value as unknown as GuardTicketRecord;
}

function parseLease(value: unknown): LeaseRecord | undefined {
  if (!isRecord(value) || !exactKeys(value, RECORD_KEYS)) return undefined;
  if (value.version !== VERSION || !validToken(value.token) || !positiveSafeInteger(value.pid)) return undefined;
  if (value.role !== "foreground" && value.role !== "background") return undefined;
  if (!positiveSafeInteger(value.sequence) || !nonNegativeSafeInteger(value.createdAtMs)) return undefined;
  return value as unknown as LeaseRecord;
}

function parseSequence(value: unknown): SequenceRecord | undefined {
  if (!isRecord(value) || !exactKeys(value, SEQUENCE_KEYS)) return undefined;
  if (value.version !== VERSION || !positiveSafeInteger(value.nextSequence)) return undefined;
  return value as unknown as SequenceRecord;
}

async function readJson(file: string): Promise<unknown | undefined> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw stateError();
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw stateError();
    if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o600) throw stateError();
    return JSON.parse(await fs.readFile(file, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    if (error instanceof LocalModelExecutionLeaseError) throw error;
    throw stateError();
  }
}

function stateError(): LocalModelExecutionLeaseError {
  return new LocalModelExecutionLeaseError(
    "STATE_UNAVAILABLE",
    "local model execution lease state is unavailable"
  );
}

function abortError(): LocalModelExecutionLeaseError {
  return new LocalModelExecutionLeaseError(
    "REQUEST_ABORTED",
    "local model execution lease request was cancelled"
  );
}

function timeoutError(): LocalModelExecutionLeaseError {
  return new LocalModelExecutionLeaseError(
    "QUEUE_TIMEOUT",
    "local model execution lease queue timed out"
  );
}

function defaultLiveness(pid: number): ProcessLiveness {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "dead";
    if (code === "EPERM") return "alive";
    return "unknown";
  }
}

async function defaultWait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw abortError();
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function inode(file: string): Promise<{ dev: bigint; ino: bigint } | undefined> {
  try {
    const stat = await fs.lstat(file, { bigint: true });
    return { dev: stat.dev, ino: stat.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function sameInode(
  left: { dev: bigint; ino: bigint } | undefined,
  right: { dev: bigint; ino: bigint } | undefined
): boolean {
  return left !== undefined && right !== undefined && left.dev === right.dev && left.ino === right.ino;
}

export class FileLocalModelExecutionLeaseCoordinator {
  readonly #root: string;
  readonly #pid: number;
  readonly #foregroundWaitMs: number;
  readonly #backgroundWaitMs: number;
  readonly #pollMs: number;
  readonly #now: () => number;
  readonly #token: () => string;
  readonly #liveness: (pid: number) => ProcessLiveness;
  readonly #wait: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly #onGuardStage: NonNullable<LocalModelExecutionLeaseOptions["onGuardStage"]> | undefined;

  constructor(options: LocalModelExecutionLeaseOptions = {}) {
    this.#root = options.root ?? resolveLocalModelExecutionLeaseRoot();
    if (!isAbsolute(this.#root) || this.#root.includes("\0")) throw stateError();
    this.#pid = positiveSafeInteger(options.pid) ? options.pid : process.pid;
    this.#foregroundWaitMs = integer(options.foregroundWaitMs, DEFAULT_LOCAL_MODEL_FOREGROUND_WAIT_MS, 1, MAX_FOREGROUND_WAIT_MS);
    this.#backgroundWaitMs = integer(options.backgroundWaitMs, DEFAULT_LOCAL_MODEL_BACKGROUND_WAIT_MS, 0, MAX_BACKGROUND_WAIT_MS);
    this.#pollMs = integer(options.pollMs, DEFAULT_LOCAL_MODEL_POLL_MS, MIN_POLL_MS, MAX_POLL_MS);
    this.#now = options.now ?? Date.now;
    this.#token = options.token ?? (() => randomUUID().replaceAll("-", ""));
    this.#liveness = options.processLiveness ?? defaultLiveness;
    this.#wait = options.wait ?? defaultWait;
    this.#onGuardStage = options.onGuardStage;
  }

  async acquire(role: LocalModelExecutionRole, signal?: AbortSignal): Promise<LocalModelExecutionLease> {
    if (signal?.aborted) throw abortError();
    await this.#ensureRoot();
    const token = this.#token();
    if (!validToken(token)) throw stateError();
    const startedAt = this.#now();
    const waitLimit = role === "foreground" ? this.#foregroundWaitMs : this.#backgroundWaitMs;
    const deadlineMs = startedAt + waitLimit;
    const ticket = await this.#withGuard(async () => this.#publishTicket(token, role), signal, deadlineMs);
    let claimed: LeaseRecord | undefined;
    try {
      while (!claimed) {
        if (signal?.aborted) throw abortError();
        claimed = await this.#withGuard(async () => this.#tryClaim(ticket), signal, deadlineMs);
        if (claimed) break;
        if (this.#now() - startedAt >= waitLimit) throw timeoutError();
        await this.#wait(this.#pollMs, signal);
      }
      const activeIdentity = await inode(this.#activeFile());
      if (!activeIdentity || !(await this.#activeMatches(claimed))) {
        throw new LocalModelExecutionLeaseError(
          "LEASE_LOST",
          "local model execution lease ownership was lost"
        );
      }
      const waitMs = Math.max(0, this.#now() - startedAt);
      let released = false;
      let releasing: Promise<void> | undefined;
      return {
        createdAtMs: claimed.createdAtMs,
        pid: claimed.pid,
        role,
        sequence: claimed.sequence,
        token: claimed.token,
        waitMs,
        validate: async () => sameInode(activeIdentity, await inode(this.#activeFile()))
          && this.#activeMatches(claimed!),
        hasForegroundWaiter: async (signal) => this.#withGuard(async () => {
          const tickets = await this.#liveTickets();
          return tickets.some((entry) => entry.role === "foreground");
        }, signal, this.#now() + this.#foregroundWaitMs),
        release: async () => {
          if (released) return;
          if (!releasing) {
            releasing = this.#withGuard(async () => {
              if (sameInode(activeIdentity, await inode(this.#activeFile())) && await this.#activeMatches(claimed!)) {
                await fs.unlink(this.#activeFile());
                await syncDirectory(this.#root);
              }
            }, undefined, this.#now() + this.#foregroundWaitMs)
              .then(() => { released = true; })
              .finally(() => { releasing = undefined; });
          }
          await releasing;
        }
      };
    } catch (error) {
      if (!claimed) {
        try {
          await this.#withGuard(
            async () => this.#removeOwnTicket(ticket),
            undefined,
            this.#now() + this.#foregroundWaitMs
          );
        } catch {
          throw stateError();
        }
      }
      if (error instanceof LocalModelExecutionLeaseError) throw error;
      throw stateError();
    }
  }

  async #ensureRoot(): Promise<void> {
    try {
      await fs.mkdir(this.#root, { mode: 0o700, recursive: true });
      await this.#validateDirectory(this.#root);
      await fs.mkdir(this.#candidatesDir(), { mode: 0o700, recursive: true });
      await fs.mkdir(this.#guardsDir(), { mode: 0o700, recursive: true });
      await fs.mkdir(this.#ticketsDir(), { mode: 0o700, recursive: true });
      await this.#validateDirectory(this.#candidatesDir());
      await this.#validateDirectory(this.#guardsDir());
      await this.#validateDirectory(this.#ticketsDir());
    } catch (error) {
      if (error instanceof LocalModelExecutionLeaseError) throw error;
      throw stateError();
    }
  }

  async #validateDirectory(directory: string): Promise<void> {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw stateError();
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw stateError();
    if (process.platform !== "win32" && (stat.mode & 0o777) !== 0o700) throw stateError();
  }

  async #publishCandidate(name: string, value: GuardRecord | GuardTicketRecord | LeaseRecord): Promise<string> {
    const candidate = join(this.#candidatesDir(), `${name}-${value.token}.json`);
    await atomicWriteFile(candidate, `${JSON.stringify(value)}\n`, { mode: 0o600 });
    return candidate;
  }

  async #withGuard<T>(
    operation: () => Promise<T>,
    signal?: AbortSignal,
    deadlineMs = this.#now() + this.#foregroundWaitMs
  ): Promise<T> {
    const token = this.#token();
    if (!validToken(token)) throw stateError();
    const choosing: GuardRecord = { createdAtMs: this.#now(), pid: this.#pid, token, version: VERSION };
    let choosingPublished = false;
    let ticket: GuardTicketRecord | undefined;
    let ticketIdentity: { dev: bigint; ino: bigint } | undefined;
    let result: T | undefined;
    let failed = false;
    let failure: unknown;
    try {
      await this.#publishGuardArtifact("choosing", choosing);
      choosingPublished = true;
      await this.#onGuardStage?.("choosing-published", token);

      const observed = await this.#liveGuardState();
      const maxSequence = observed.tickets.reduce(
        (maximum, entry) => Math.max(maximum, entry.sequence),
        0
      );
      if (maxSequence >= Number.MAX_SAFE_INTEGER) throw stateError();
      ticket = { ...choosing, sequence: maxSequence + 1 };
      await this.#publishGuardArtifact("guard", ticket);
      ticketIdentity = await inode(this.#guardTicketFile(token));
      if (!ticketIdentity) throw stateError();
      await this.#removeOwnGuardArtifact(this.#guardChoosingFile(token), choosing, parseGuard);
      choosingPublished = false;
      await this.#onGuardStage?.("ticket-published", token);

      for (;;) {
        if (signal?.aborted) throw abortError();
        const state = await this.#liveGuardState();
        const own = state.tickets.find((entry) => entry.token === token);
        if (
          !own
          || own.pid !== this.#pid
          || own.sequence !== ticket.sequence
          || !sameInode(ticketIdentity, await inode(this.#guardTicketFile(token)))
        ) {
          throw stateError();
        }
        if (state.choosing.length === 0) {
          state.tickets.sort((left, right) => left.sequence - right.sequence || left.token.localeCompare(right.token));
          if (state.tickets[0]?.token === token) break;
        }
        if (this.#now() >= deadlineMs) throw timeoutError();
        await this.#wait(this.#pollMs, signal);
      }
      await this.#onGuardStage?.("entered", token);
      if (signal?.aborted) throw abortError();
      if (!await this.#guardTicketMatches(ticket, ticketIdentity)) throw stateError();
      result = await operation();
      if (!await this.#guardTicketMatches(ticket, ticketIdentity)) throw stateError();
    } catch (error) {
      failed = true;
      failure = error;
    }

    try {
      if (choosingPublished) {
        await this.#removeOwnGuardArtifact(this.#guardChoosingFile(token), choosing, parseGuard);
      }
      if (ticket) {
        await this.#removeOwnGuardArtifact(this.#guardTicketFile(token), ticket, parseGuardTicket);
      }
    } catch {
      throw stateError();
    }
    if (failed) {
      if (failure instanceof LocalModelExecutionLeaseError) throw failure;
      throw stateError();
    }
    return result as T;
  }

  async #publishGuardArtifact(
    kind: "choosing" | "guard",
    record: GuardRecord | GuardTicketRecord
  ): Promise<void> {
    const candidate = await this.#publishCandidate(kind, record).catch(() => { throw stateError(); });
    const target = kind === "choosing"
      ? this.#guardChoosingFile(record.token)
      : this.#guardTicketFile(record.token);
    try {
      await fs.link(candidate, target);
      await syncDirectory(this.#guardsDir());
    } catch {
      throw stateError();
    } finally {
      await fs.unlink(candidate).catch(() => undefined);
    }
  }

  async #liveGuardState(): Promise<{
    readonly choosing: GuardRecord[];
    readonly tickets: GuardTicketRecord[];
  }> {
    let names: string[];
    try {
      names = await fs.readdir(this.#guardsDir());
    } catch {
      throw stateError();
    }
    const choosing: GuardRecord[] = [];
    const tickets: GuardTicketRecord[] = [];
    for (const name of names) {
      const choosingMatch = /^choosing-([A-Za-z0-9_-]{8,128})\.json$/u.exec(name);
      const guardMatch = /^guard-([A-Za-z0-9_-]{8,128})\.json$/u.exec(name);
      if (!choosingMatch && !guardMatch) throw stateError();
      const file = join(this.#guardsDir(), name);
      const identity = await inode(file);
      const value = await readJson(file);
      const record = choosingMatch ? parseGuard(value) : parseGuardTicket(value);
      const expectedToken = (choosingMatch ?? guardMatch)![1];
      if (!record) {
        const currentIdentity = await inode(file);
        if (currentIdentity === undefined || !sameInode(identity, currentIdentity)) continue;
        throw stateError();
      }
      if (record.token !== expectedToken) throw stateError();
      const status = this.#liveness(record.pid);
      if (status === "unknown") throw stateError();
      if (status === "dead") {
        const parser = choosingMatch ? parseGuard : parseGuardTicket;
        await this.#removeOwnGuardArtifact(file, record, parser, identity);
        continue;
      }
      if (choosingMatch) choosing.push(record as GuardRecord);
      else tickets.push(record as GuardTicketRecord);
    }
    return { choosing, tickets };
  }

  async #guardTicketMatches(
    ticket: GuardTicketRecord,
    identity: { dev: bigint; ino: bigint }
  ): Promise<boolean> {
    const file = this.#guardTicketFile(ticket.token);
    const current = parseGuardTicket(await readJson(file));
    return current?.pid === ticket.pid
      && current.sequence === ticket.sequence
      && current.token === ticket.token
      && sameInode(identity, await inode(file));
  }

  async #removeOwnGuardArtifact<T extends GuardRecord>(
    file: string,
    record: T,
    parser: (value: unknown) => T | undefined,
    observedIdentity?: { dev: bigint; ino: bigint }
  ): Promise<void> {
    const identity = observedIdentity ?? await inode(file);
    const current = parser(await readJson(file));
    if (
      current?.token === record.token
      && current.pid === record.pid
      && sameInode(identity, await inode(file))
    ) {
      await fs.unlink(file);
      await syncDirectory(this.#guardsDir());
    }
  }

  async #publishTicket(token: string, role: LocalModelExecutionRole): Promise<LeaseRecord> {
    const sequenceValue = await readJson(this.#sequenceFile());
    const current = sequenceValue === undefined ? { nextSequence: 1, version: VERSION } : parseSequence(sequenceValue);
    if (!current || current.nextSequence >= Number.MAX_SAFE_INTEGER) throw stateError();
    const record: LeaseRecord = {
      createdAtMs: this.#now(),
      pid: this.#pid,
      role,
      sequence: current.nextSequence,
      token,
      version: VERSION
    };
    await atomicWriteFile(this.#sequenceFile(), `${JSON.stringify({
      nextSequence: current.nextSequence + 1,
      version: VERSION
    } satisfies SequenceRecord)}\n`, { mode: 0o600 });
    const candidate = await this.#publishCandidate("ticket", record);
    try {
      await fs.link(candidate, this.#ticketFile(token));
      await syncDirectory(this.#ticketsDir());
    } finally {
      await fs.unlink(candidate).catch(() => undefined);
    }
    return record;
  }

  async #tryClaim(ticket: LeaseRecord): Promise<LeaseRecord | undefined> {
    const tickets = await this.#liveTickets();
    const activeValue = await readJson(this.#activeFile());
    if (activeValue !== undefined) {
      const active = parseLease(activeValue);
      if (!active) throw stateError();
      const activeIdentity = await inode(this.#activeFile());
      const status = this.#liveness(active.pid);
      if (status === "unknown") throw stateError();
      if (status === "dead") {
        const recheck = parseLease(await readJson(this.#activeFile()));
        if (recheck?.token === active.token && sameInode(activeIdentity, await inode(this.#activeFile()))) {
          await fs.unlink(this.#activeFile());
          await syncDirectory(this.#root);
        }
      } else {
        return undefined;
      }
    }
    const foreground = tickets.filter((entry) => entry.role === "foreground");
    const pool = foreground.length > 0 ? foreground : tickets.filter((entry) => entry.role === "background");
    pool.sort((left, right) => left.sequence - right.sequence || left.token.localeCompare(right.token));
    if (pool[0]?.token !== ticket.token) return undefined;
    const candidate = await this.#publishCandidate("active", ticket);
    try {
      await fs.link(candidate, this.#activeFile());
      await syncDirectory(this.#root);
      await this.#removeOwnTicket(ticket);
      return ticket;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return undefined;
      throw stateError();
    } finally {
      await fs.unlink(candidate).catch(() => undefined);
    }
  }

  async #liveTickets(): Promise<LeaseRecord[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.#ticketsDir());
    } catch {
      throw stateError();
    }
    const tickets: LeaseRecord[] = [];
    for (const name of names) {
      if (!/^ticket-[A-Za-z0-9_-]{8,128}\.json$/u.test(name)) throw stateError();
      const file = join(this.#ticketsDir(), name);
      const ticket = parseLease(await readJson(file));
      if (!ticket || name !== `ticket-${ticket.token}.json`) throw stateError();
      const ticketIdentity = await inode(file);
      const status = this.#liveness(ticket.pid);
      if (status === "unknown") throw stateError();
      if (status === "dead") {
        const recheck = parseLease(await readJson(file));
        if (recheck?.token === ticket.token && sameInode(ticketIdentity, await inode(file))) {
          await fs.unlink(file);
          await syncDirectory(this.#ticketsDir());
        }
        continue;
      }
      tickets.push(ticket);
    }
    return tickets;
  }

  async #removeOwnTicket(ticket: LeaseRecord): Promise<void> {
    const file = this.#ticketFile(ticket.token);
    const ticketIdentity = await inode(file);
    const current = parseLease(await readJson(file));
    if (
      current?.token === ticket.token
      && current.pid === ticket.pid
      && sameInode(ticketIdentity, await inode(file))
    ) {
      await fs.unlink(file);
      await syncDirectory(this.#ticketsDir());
    }
  }

  async #activeMatches(record: LeaseRecord): Promise<boolean> {
    const current = parseLease(await readJson(this.#activeFile()));
    return current?.token === record.token && current.pid === record.pid && current.sequence === record.sequence;
  }

  #activeFile(): string { return join(this.#root, "active.json"); }
  #sequenceFile(): string { return join(this.#root, "sequence.json"); }
  #candidatesDir(): string { return join(this.#root, "candidates"); }
  #guardsDir(): string { return join(this.#root, "guards"); }
  #ticketsDir(): string { return join(this.#root, "tickets"); }
  #guardChoosingFile(token: string): string { return join(this.#guardsDir(), `choosing-${token}.json`); }
  #guardTicketFile(token: string): string { return join(this.#guardsDir(), `guard-${token}.json`); }
  #ticketFile(token: string): string { return join(this.#ticketsDir(), `ticket-${token}.json`); }
}
