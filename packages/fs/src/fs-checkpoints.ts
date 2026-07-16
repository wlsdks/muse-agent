/**
 * Undo substrate for `@muse/fs`'s write-tier tools — every file_write /
 * file_edit / file_multi_edit / file_delete / file_move snapshots the
 * target's CURRENT state here before mutating it, so `muse rollback` (CLI)
 * can restore it. Layout: `<dir>/<checkpoint-id>/manifest.json` +
 * `<dir>/<checkpoint-id>/content` (original bytes, present only when the
 * file existed and fit the per-snapshot cap). This module stays DUMB on
 * purpose — record/list/get only; restore semantics (write back vs delete
 * vs move-back, the pre-rollback safety checkpoint) live in the CLI command
 * that owns the decision of what "undo" means for each action.
 *
 * `.muse/` is itself in the fs sandbox's deny-list (`fs-path-safety.ts`), so
 * the agent's OWN write tools can never reach into `~/.muse/checkpoints` —
 * this store writes there directly with plain `node:fs`, never through
 * `resolveSafePath`.
 */

import { randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const MANIFEST_FILE = "manifest.json";
const CONTENT_FILE = "content";
const TMP_PREFIX = ".tmp-";

export const DEFAULT_MAX_BYTES_PER_SNAPSHOT = 10 * 1024 * 1024;
export const DEFAULT_MAX_CHECKPOINTS = 200;

/**
 * The manifest format version this build writes and fully understands. A
 * manifest with no `version` field predates R3-5 and is treated as `1` (every
 * checkpoint ever written stays restorable). A manifest with a version
 * GREATER than this constant was written by a newer Muse — its shape may
 * carry fields this build doesn't know how to restore safely, so callers
 * must refuse to restore it (fail-closed) rather than guess.
 */
export const CURRENT_CHECKPOINT_VERSION = 1;

export type CheckpointAction = "write" | "edit" | "multi_edit" | "delete" | "move";

export interface CheckpointManifest {
  readonly id: string;
  /** ISO timestamp of the snapshot. */
  readonly at: string;
  readonly action: CheckpointAction;
  /** Absolute path the checkpoint is FOR — the move target for `action: "move"`. */
  readonly path: string;
  readonly summary: string;
  readonly existedBefore: boolean;
  readonly bytes: number;
  /** Present (`true`) when the original exceeded the per-snapshot cap — content was NOT stored, rollback must refuse. */
  readonly truncated?: true;
  /** `action: "move"` only — the pre-move source path, so rollback can rename back instead of losing the file. */
  readonly fromPath?: string;
  /** Manifest format version. Absent on-disk reads as `1` — see `CURRENT_CHECKPOINT_VERSION`. */
  readonly version: number;
}

export interface CheckpointRecord extends CheckpointManifest {
  /** The original file's RAW bytes — present iff `existedBefore && !truncated`. */
  readonly content?: Buffer;
}

/**
 * A string is accepted for convenience (most callers snapshot plain text and
 * `Buffer.from(text, "utf8")` round-trips losslessly for them), but a
 * snapshot of a file already on disk MUST be a `Buffer`/`Uint8Array` read
 * WITHOUT a text encoding — a JPEG, or any file with a byte sequence that
 * isn't valid UTF-8, silently corrupts to U+FFFD replacement characters the
 * moment it round-trips through a JS string. `fs-write-tools.ts` always
 * passes raw bytes for a real on-disk snapshot.
 */
export type CheckpointContent = Buffer | Uint8Array | string;

function toBuffer(content: CheckpointContent): Buffer {
  return typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content);
}

export interface CheckpointRecordInput {
  readonly action: CheckpointAction;
  readonly path: string;
  readonly summary: string;
  /** `undefined` means the file did NOT exist before this action (existedBefore:false). */
  readonly originalContent: CheckpointContent | undefined;
  readonly fromPath?: string;
}

export interface CheckpointStore {
  /** Snapshots the current state and returns the new checkpoint's id. */
  record(input: CheckpointRecordInput): Promise<string>;
  /** Newest-first, manifest only (no content — cheap to list). */
  list(): Promise<readonly CheckpointManifest[]>;
  get(id: string): Promise<CheckpointRecord | undefined>;
}

export function defaultCheckpointsDir(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const fromEnv = env.MUSE_CHECKPOINTS_DIR?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : join(homedir(), ".muse", "checkpoints");
}

export function defaultMaxCheckpoints(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const fromEnv = env.MUSE_CHECKPOINTS_MAX?.trim();
  const parsed = fromEnv ? Number(fromEnv) : Number.NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_CHECKPOINTS;
}

function newCheckpointId(): string {
  return `ckpt_${randomUUID().replace(/-/gu, "").slice(0, 12)}`;
}

const CHECKPOINT_ACTIONS: ReadonlySet<string> = new Set(["write", "edit", "multi_edit", "delete", "move"]);
const CHECKPOINT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u;

function isSafeCheckpointId(id: string): boolean {
  return CHECKPOINT_ID_PATTERN.test(id);
}

function requireSafeCheckpointId(id: string): string {
  if (!isSafeCheckpointId(id)) {
    throw new TypeError("Checkpoint id must contain only filesystem-safe characters");
  }

  return id;
}

function requirePositiveSafeInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }

  return resolved;
}

/** A pre-R3-5 manifest has no `version` field at all — that (and any malformed value) reads as `1`, the format every existing on-disk checkpoint was written in. */
function reviveVersion(raw: unknown): number {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 1 ? raw : 1;
}

function reviveManifest(raw: unknown): CheckpointManifest | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id.length === 0) return undefined;
  if (typeof r.at !== "string") return undefined;
  if (typeof r.action !== "string" || !CHECKPOINT_ACTIONS.has(r.action)) return undefined;
  if (typeof r.path !== "string") return undefined;
  if (typeof r.summary !== "string") return undefined;
  if (typeof r.existedBefore !== "boolean") return undefined;
  if (typeof r.bytes !== "number" || !Number.isFinite(r.bytes)) return undefined;
  return {
    action: r.action as CheckpointAction,
    at: r.at,
    bytes: r.bytes,
    existedBefore: r.existedBefore,
    id: r.id,
    path: r.path,
    summary: r.summary,
    version: reviveVersion(r.version),
    ...(r.truncated === true ? { truncated: true as const } : {}),
    ...(typeof r.fromPath === "string" ? { fromPath: r.fromPath } : {})
  };
}

async function quarantine(dirPath: string): Promise<void> {
  try {
    await rename(dirPath, `${dirPath}.corrupt-${Date.now().toString()}`);
  } catch {
    // best-effort — list() still just skips it either way
  }
}

export interface FileCheckpointStoreOptions {
  readonly dir?: string;
  readonly maxCheckpoints?: number;
  readonly maxBytesPerSnapshot?: number;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

/** Disk-backed `CheckpointStore` — `~/.muse/checkpoints/<id>/` per snapshot. */
export class FileCheckpointStore implements CheckpointStore {
  private readonly dir: string;
  private readonly maxCheckpoints: number;
  private readonly maxBytes: number;
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(options: FileCheckpointStoreOptions = {}) {
    this.dir = options.dir && options.dir.trim().length > 0 ? options.dir : defaultCheckpointsDir();
    this.maxCheckpoints = requirePositiveSafeInteger(options.maxCheckpoints, DEFAULT_MAX_CHECKPOINTS, "maxCheckpoints");
    this.maxBytes = requirePositiveSafeInteger(options.maxBytesPerSnapshot, DEFAULT_MAX_BYTES_PER_SNAPSHOT, "maxBytesPerSnapshot");
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? newCheckpointId;
  }

  async record(input: CheckpointRecordInput): Promise<string> {
    const id = requireSafeCheckpointId(this.idFactory());
    const originalBuffer = input.originalContent === undefined ? undefined : toBuffer(input.originalContent);
    const existedBefore = originalBuffer !== undefined;
    const bytes = existedBefore ? originalBuffer.length : 0;
    const truncated = existedBefore && bytes > this.maxBytes;
    const manifest: CheckpointManifest = {
      action: input.action,
      at: this.now().toISOString(),
      bytes,
      existedBefore,
      id,
      path: input.path,
      summary: input.summary,
      version: CURRENT_CHECKPOINT_VERSION,
      ...(truncated ? { truncated: true as const } : {}),
      ...(input.fromPath ? { fromPath: input.fromPath } : {})
    };
    await mkdir(this.dir, { recursive: true });
    const finalDir = join(this.dir, id);
    const tmpDir = join(this.dir, `${TMP_PREFIX}${id}`);
    await rm(tmpDir, { force: true, recursive: true }).catch(() => undefined);
    await mkdir(tmpDir, { recursive: true });
    try {
      await writeFile(join(tmpDir, MANIFEST_FILE), JSON.stringify(manifest, null, 2), "utf8");
      if (existedBefore && !truncated) {
        // NO encoding — write the RAW bytes back exactly (a text encoding here
        // would silently corrupt a JPEG/binary/invalid-UTF-8 snapshot; see
        // `CheckpointContent`'s doc comment).
        await writeFile(join(tmpDir, CONTENT_FILE), originalBuffer);
      }
      // Directory rename is atomic on POSIX — the checkpoint appears whole or not at all.
      await rename(tmpDir, finalDir);
    } catch (error) {
      await rm(tmpDir, { force: true, recursive: true }).catch(() => undefined);
      throw error;
    }
    await this.evictOverCap(id);
    return id;
  }

  async list(): Promise<readonly CheckpointManifest[]> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const manifests: CheckpointManifest[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(TMP_PREFIX)) continue;
      const dirPath = join(this.dir, entry.name);
      let raw: string;
      try {
        raw = await readFile(join(dirPath, MANIFEST_FILE), "utf8");
      } catch {
        continue; // no manifest — nothing to quarantine, just not a checkpoint
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        await quarantine(dirPath);
        continue;
      }
      const manifest = reviveManifest(parsed);
      if (!manifest) {
        await quarantine(dirPath);
        continue;
      }
      manifests.push(manifest);
    }
    return manifests.sort((a, b) => b.at.localeCompare(a.at));
  }

  async get(id: string): Promise<CheckpointRecord | undefined> {
    if (!isSafeCheckpointId(id)) {
      return undefined;
    }

    const dirPath = join(this.dir, id);
    let raw: string;
    try {
      raw = await readFile(join(dirPath, MANIFEST_FILE), "utf8");
    } catch {
      return undefined;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    const manifest = reviveManifest(parsed);
    if (!manifest) return undefined;
    if (!manifest.existedBefore || manifest.truncated) return manifest;
    try {
      // NO encoding — read RAW bytes (a Buffer), never decode through UTF-8.
      const content = await readFile(join(dirPath, CONTENT_FILE));
      return { ...manifest, content };
    } catch {
      return manifest; // content missing/unreadable — degrade to manifest-only rather than throw
    }
  }

  /**
   * Drop-oldest eviction once retention exceeds the cap. Never evicts
   * `justWrittenId` — the checkpoint that triggered this call always
   * survives its own write.
   */
  private async evictOverCap(justWrittenId: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(this.dir, { withFileTypes: true });
    } catch {
      return;
    }
    const dirs = entries.filter((e) => e.isDirectory() && !e.name.startsWith(TMP_PREFIX));
    if (dirs.length <= this.maxCheckpoints) return;
    const withAt = await Promise.all(
      dirs.map(async (d) => {
        try {
          const raw = await readFile(join(this.dir, d.name, MANIFEST_FILE), "utf8");
          const parsed = JSON.parse(raw) as { at?: unknown };
          return { at: typeof parsed.at === "string" ? parsed.at : "", name: d.name };
        } catch {
          return { at: "", name: d.name }; // unreadable sorts oldest — evicted first, which is fine
        }
      })
    );
    withAt.sort((a, b) => a.at.localeCompare(b.at)); // oldest first
    const overflow = withAt.length - this.maxCheckpoints;
    let removed = 0;
    for (const entry of withAt) {
      if (removed >= overflow) break;
      if (entry.name === justWrittenId) continue;
      await rm(join(this.dir, entry.name), { force: true, recursive: true }).catch(() => undefined);
      removed += 1;
    }
  }
}

/**
 * Ephemeral, process-local fallback — never touches disk. Used by the write
 * tools as `checkpointStore`'s default when a construction site doesn't
 * provide one (most existing unit tests): writes still succeed, but nothing
 * survives the process and `muse rollback` has nothing to see. The real
 * agent write path (CLI) always wires a `FileCheckpointStore` instead.
 */
export function createInMemoryCheckpointStore(): CheckpointStore {
  const entries = new Map<string, CheckpointRecord>();
  return {
    async get(id) {
      return entries.get(id);
    },
    async list() {
      return [...entries.values()]
        .map(({ content: _content, ...manifest }) => manifest)
        .sort((a, b) => b.at.localeCompare(a.at));
    },
    async record(input) {
      const id = newCheckpointId();
      const originalBuffer = input.originalContent === undefined ? undefined : toBuffer(input.originalContent);
      const existedBefore = originalBuffer !== undefined;
      const bytes = existedBefore ? originalBuffer.length : 0;
      entries.set(id, {
        action: input.action,
        at: new Date().toISOString(),
        bytes,
        existedBefore,
        id,
        path: input.path,
        summary: input.summary,
        version: CURRENT_CHECKPOINT_VERSION,
        ...(existedBefore ? { content: originalBuffer } : {}),
        ...(input.fromPath ? { fromPath: input.fromPath } : {})
      });
      return id;
    }
  };
}
