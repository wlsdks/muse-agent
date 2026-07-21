import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { constants as fsConstants, promises as fs } from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  resolve
} from "node:path";
import { isProxy } from "node:util/types";

import { resolveNotesDir, resolveNotesIndexFile } from "@muse/autoconfigure";
import {
  NOTES_CHUNKER_VERSION,
  NOTES_INDEX_SCHEMA_VERSION,
  NOTE_SPAN_IDENTITY_SCHEMA_V1,
  SUPERSEDES_RELATION_SCHEMA_V1,
  type NoteSpanIdentityV1,
  type SupersedesRelationV1
} from "@muse/recall";
import {
  PrivateFileLockError,
  withFileMutationQueue,
  withPrivateFileLock
} from "@muse/shared";

type Environment = Readonly<Record<string, string | undefined>>;

export const NOTE_RELATIONS_STORE_SCHEMA_V1 = "muse.note-relations.store.v1" as const;
const MAX_STORE_BYTES = 4 * 1_024 * 1_024;
const MAX_STORE_RELATIONS = 1_024;
const FATAL_UTF8 = new TextDecoder("utf-8", { fatal: true });

export type NoteRelationsStoreErrorCode =
  | "STORE_PATH_UNSAFE"
  | "STORE_UNSAFE"
  | "STORE_CORRUPT"
  | "STORE_LOCKED"
  | "STORE_IO";

export class NoteRelationsStoreError extends Error {
  readonly code: NoteRelationsStoreErrorCode;

  constructor(code: NoteRelationsStoreErrorCode, message = "Note relations store is unavailable.") {
    super(message);
    this.name = "NoteRelationsStoreError";
    this.code = code;
    this.stack = `${this.name}: ${this.message}`;
  }
}

export interface NoteRelationsPathSnapshot {
  readonly env: Environment;
  readonly home: string;
  readonly museRoot: string;
  readonly notesDir: string;
  readonly notesIndexFile: string;
  readonly storeFile: string;
  readonly lockFile: string;
}

export interface ReadNoteRelationsStoreResult {
  readonly state: "absent" | "empty" | "valid";
  readonly revision: number;
  readonly rawDigest: string | null;
  readonly relations: readonly SupersedesRelationV1[];
}

export type NoteRelationsRootEvidence =
  | {
      readonly rootState: "absent";
      readonly homeIdentity: FileIdentity;
    }
  | {
      readonly rootState: "present";
      readonly homeIdentity: FileIdentity;
      readonly rootIdentity: FileIdentity & { readonly mode: number; readonly realpath: string };
    };

interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
}

function freezeEnvironment(env: Environment): Environment {
  if (isProxy(env)) {
    throw new NoteRelationsStoreError("STORE_PATH_UNSAFE");
  }
  const snapshot: Record<string, string | undefined> = {};
  for (const key of Reflect.ownKeys(env)) {
    if (typeof key !== "string") {
      throw new NoteRelationsStoreError("STORE_PATH_UNSAFE");
    }
    const descriptor = Object.getOwnPropertyDescriptor(env, key);
    if (!descriptor || !Object.hasOwn(descriptor, "value")) {
      throw new NoteRelationsStoreError("STORE_PATH_UNSAFE");
    }
    if (typeof descriptor.value === "string" || descriptor.value === undefined) {
      snapshot[key] = descriptor.value;
    }
  }
  return Object.freeze(snapshot);
}

export function resolveNoteRelationsPathSnapshot(env: Environment = process.env): NoteRelationsPathSnapshot {
  const initial = freezeEnvironment(env);
  const homeValue = initial.HOME?.trim() || homedir().trim();
  if (homeValue.length === 0 || !isAbsolute(homeValue)) {
    throw new NoteRelationsStoreError("STORE_PATH_UNSAFE");
  }
  const home = resolve(homeValue);
  const museRoot = join(home, ".muse");
  const override = initial.MUSE_NOTE_RELATIONS_FILE?.trim();
  const storeFile = override && override.length > 0
    ? (isAbsolute(override) ? resolve(override) : "")
    : join(museRoot, "note-relations.json");
  if (
    storeFile.length === 0
    || dirname(storeFile) !== museRoot
    || basename(storeFile).length === 0
  ) {
    throw new NoteRelationsStoreError("STORE_PATH_UNSAFE");
  }
  const frozenEnv = Object.freeze({ ...initial, HOME: home });
  return Object.freeze({
    env: frozenEnv,
    home,
    lockFile: `${storeFile}.lock`,
    museRoot,
    notesDir: resolveNotesDir(frozenEnv),
    notesIndexFile: resolveNotesIndexFile(frozenEnv),
    storeFile
  });
}

function storeUnsafe(): never {
  throw new NoteRelationsStoreError("STORE_UNSAFE");
}

function fileIdentity(stats: Awaited<ReturnType<typeof fs.lstat>>): FileIdentity {
  return { dev: Number(stats.dev), ino: Number(stats.ino), uid: Number(stats.uid) };
}

function assertOwned(stats: Awaited<ReturnType<typeof fs.lstat>>): void {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && stats.uid !== uid) {
    storeUnsafe();
  }
}

async function openVerifiedDirectory(path: string, expected: Awaited<ReturnType<typeof fs.lstat>>) {
  const flags = fsConstants.O_RDONLY
    | (fsConstants.O_DIRECTORY ?? 0)
    | (fsConstants.O_NOFOLLOW ?? 0);
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(path, flags);
  } catch {
    return storeUnsafe();
  }
  try {
    const opened = await handle.stat();
    if (!opened.isDirectory() || opened.dev !== expected.dev || opened.ino !== expected.ino) {
      storeUnsafe();
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function lstatOrAbsent(path: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | undefined> {
  try {
    return await fs.lstat(path);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return storeUnsafe();
  }
}

export async function verifyNoteRelationsRoot(
  paths: NoteRelationsPathSnapshot,
  options: { readonly create: boolean }
): Promise<NoteRelationsRootEvidence> {
  const homeStats = await lstatOrAbsent(paths.home);
  if (!homeStats || !homeStats.isDirectory() || homeStats.isSymbolicLink()) {
    return storeUnsafe();
  }
  assertOwned(homeStats);
  await openVerifiedDirectory(paths.home, homeStats);
  const homeIdentity = fileIdentity(homeStats);

  let rootStats = await lstatOrAbsent(paths.museRoot);
  if (!rootStats && !options.create) {
    return Object.freeze({ homeIdentity: Object.freeze(homeIdentity), rootState: "absent" });
  }
  if (!rootStats) {
    try {
      await fs.mkdir(paths.museRoot, { mode: 0o700, recursive: false });
    } catch {
      return storeUnsafe();
    }
    rootStats = await lstatOrAbsent(paths.museRoot);
    if (!rootStats || (Number(rootStats.mode) & 0o777) !== 0o700) {
      return storeUnsafe();
    }
  }
  if (
    !rootStats.isDirectory()
    || rootStats.isSymbolicLink()
    || (Number(rootStats.mode) & 0o022) !== 0
  ) {
    return storeUnsafe();
  }
  assertOwned(rootStats);
  await openVerifiedDirectory(paths.museRoot, rootStats);
  let rootRealpath: string;
  try {
    rootRealpath = await fs.realpath(paths.museRoot);
  } catch {
    return storeUnsafe();
  }
  return Object.freeze({
    homeIdentity: Object.freeze(homeIdentity),
    rootIdentity: Object.freeze({
      ...fileIdentity(rootStats),
      mode: Number(rootStats.mode) & 0o777,
      realpath: rootRealpath
    }),
    rootState: "present"
  });
}

function exactObjectKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

const IDENTITY_KEYS = Object.freeze([
  "schema",
  "sourcePath",
  "sourceHash",
  "notesIndexSchema",
  "chunkerVersion",
  "sourceIndexDigest",
  "chunkIndex",
  "chunkHash",
  "start",
  "end",
  "spanHash"
] as const);
const RELATION_KEYS = Object.freeze(["schema", "edgeId", "authoredAt", "current", "stale"] as const);
const SHA256_RE = /^[0-9a-f]{64}$/u;
const EDGE_ID_RE = /^[0-9a-f]{32}$/u;
const TEXT_NOTE_PATH_RE = /\.(?:md|markdown|mkd|mdown|mdx|txt|text|org|rst|adoc|asciidoc)$/iu;

function isCanonicalSourcePath(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return false;
  const bytes = Buffer.from(value, "utf8");
  const segments = value.split("/");
  return bytes.byteLength <= 512
    && FATAL_UTF8.decode(bytes) === value
    && !value.includes("\0")
    && !value.includes("\\")
    && !posix.isAbsolute(value)
    && !/^[a-z]:/iu.test(value)
    && segments.every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    && posix.normalize(value) === value
    && TEXT_NOTE_PATH_RE.test(value);
}

function parseStoredIdentity(value: unknown): NoteSpanIdentityV1 | undefined {
  if (!exactObjectKeys(value, IDENTITY_KEYS)) return undefined;
  if (
    value.schema !== NOTE_SPAN_IDENTITY_SCHEMA_V1
    || !isCanonicalSourcePath(value.sourcePath)
    || typeof value.sourceHash !== "string" || !SHA256_RE.test(value.sourceHash)
    || value.notesIndexSchema !== NOTES_INDEX_SCHEMA_VERSION
    || value.chunkerVersion !== NOTES_CHUNKER_VERSION
    || typeof value.sourceIndexDigest !== "string" || !SHA256_RE.test(value.sourceIndexDigest)
    || !Number.isSafeInteger(value.chunkIndex) || (value.chunkIndex as number) < 0
    || typeof value.chunkHash !== "string" || !SHA256_RE.test(value.chunkHash)
    || !Number.isSafeInteger(value.start) || (value.start as number) < 0
    || !Number.isSafeInteger(value.end) || (value.end as number) <= (value.start as number)
    || (value.end as number) - (value.start as number) > 4 * 1_024
    || typeof value.spanHash !== "string" || !SHA256_RE.test(value.spanHash)
  ) return undefined;
  return Object.freeze({ ...value }) as unknown as NoteSpanIdentityV1;
}

function parseStoredRelation(value: unknown): SupersedesRelationV1 | undefined {
  if (!exactObjectKeys(value, RELATION_KEYS)) return undefined;
  const current = parseStoredIdentity(value.current);
  const stale = parseStoredIdentity(value.stale);
  if (
    value.schema !== SUPERSEDES_RELATION_SCHEMA_V1
    || typeof value.edgeId !== "string" || !EDGE_ID_RE.test(value.edgeId)
    || typeof value.authoredAt !== "string"
    || !Number.isFinite(Date.parse(value.authoredAt))
    || new Date(value.authoredAt).toISOString() !== value.authoredAt
    || !current
    || !stale
  ) return undefined;
  return Object.freeze({
    authoredAt: value.authoredAt,
    current,
    edgeId: value.edgeId,
    schema: SUPERSEDES_RELATION_SCHEMA_V1,
    stale
  });
}

function assertPrivateRegularFile(stats: Awaited<ReturnType<typeof fs.lstat>>): void {
  if (!stats.isFile() || stats.isSymbolicLink() || (Number(stats.mode) & 0o777) !== 0o600) {
    storeUnsafe();
  }
  assertOwned(stats);
}

async function readStoreAtMost(handle: Awaited<ReturnType<typeof fs.open>>): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= MAX_STORE_BYTES) {
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1_024, MAX_STORE_BYTES + 1 - total));
    const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, null);
    if (bytesRead === 0) break;
    chunks.push(buffer.subarray(0, bytesRead));
    total += bytesRead;
  }
  return new Uint8Array(Buffer.concat(chunks, total));
}

async function readPrivateStoreFile(
  path: string,
  beforeRead?: () => void | Promise<void>
): Promise<Uint8Array | undefined> {
  const before = await lstatOrAbsent(path);
  if (!before) return undefined;
  assertPrivateRegularFile(before);
  if (before.size > MAX_STORE_BYTES) {
    throw new NoteRelationsStoreError("STORE_CORRUPT");
  }
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(path, flags);
  } catch {
    return storeUnsafe();
  }
  try {
    const opened = await handle.stat();
    assertPrivateRegularFile(opened as Awaited<ReturnType<typeof fs.lstat>>);
    if (
      opened.dev !== before.dev
      || opened.ino !== before.ino
      || opened.size !== before.size
      || opened.size > MAX_STORE_BYTES
    ) {
      return storeUnsafe();
    }
    await beforeRead?.();
    const bytes = await readStoreAtMost(handle);
    if (bytes.byteLength > MAX_STORE_BYTES) {
      throw new NoteRelationsStoreError("STORE_CORRUPT");
    }
    const after = await handle.stat();
    if (
      after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
    ) {
      return storeUnsafe();
    }
    return new Uint8Array(bytes);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function readNoteRelationsStore(
  paths: NoteRelationsPathSnapshot,
  options: { readonly beforeBoundedRead?: () => void | Promise<void> } = {}
): Promise<ReadNoteRelationsStoreResult> {
  const root = await verifyNoteRelationsRoot(paths, { create: false });
  if (root.rootState === "absent") {
    return Object.freeze({ rawDigest: null, relations: Object.freeze([]), revision: 0, state: "absent" });
  }
  const bytes = await readPrivateStoreFile(paths.storeFile, options.beforeBoundedRead);
  if (!bytes) {
    return Object.freeze({ rawDigest: null, relations: Object.freeze([]), revision: 0, state: "absent" });
  }
  let text: string;
  let value: unknown;
  try {
    text = FATAL_UTF8.decode(bytes);
    value = JSON.parse(text) as unknown;
  } catch {
    throw new NoteRelationsStoreError("STORE_CORRUPT");
  }
  if (
    !exactObjectKeys(value, ["schema", "revision", "relations"])
    || value.schema !== NOTE_RELATIONS_STORE_SCHEMA_V1
    || !Number.isSafeInteger(value.revision)
    || (value.revision as number) < 0
    || !Array.isArray(value.relations)
    || value.relations.length > MAX_STORE_RELATIONS
  ) {
    throw new NoteRelationsStoreError("STORE_CORRUPT");
  }
  const relations = value.relations.map(parseStoredRelation);
  if (relations.some((relation) => relation === undefined)) {
    throw new NoteRelationsStoreError("STORE_CORRUPT");
  }
  const typedRelations = Object.freeze(relations as SupersedesRelationV1[]);
  if (new Set(typedRelations.map((relation) => relation.edgeId)).size !== typedRelations.length) {
    throw new NoteRelationsStoreError("STORE_CORRUPT");
  }
  return Object.freeze({
    rawDigest: createHash("sha256").update(bytes).digest("hex"),
    relations: typedRelations,
    revision: value.revision as number,
    state: typedRelations.length === 0 ? "empty" : "valid"
  });
}

function canonicalIdentity(identity: NoteSpanIdentityV1) {
  return {
    schema: identity.schema,
    sourcePath: identity.sourcePath,
    sourceHash: identity.sourceHash,
    notesIndexSchema: identity.notesIndexSchema,
    chunkerVersion: identity.chunkerVersion,
    sourceIndexDigest: identity.sourceIndexDigest,
    chunkIndex: identity.chunkIndex,
    chunkHash: identity.chunkHash,
    start: identity.start,
    end: identity.end,
    spanHash: identity.spanHash
  };
}

function canonicalRelation(relation: SupersedesRelationV1) {
  return {
    schema: relation.schema,
    edgeId: relation.edgeId,
    authoredAt: relation.authoredAt,
    current: canonicalIdentity(relation.current),
    stale: canonicalIdentity(relation.stale)
  };
}

function canonicalStoreBytes(revision: number, relations: readonly SupersedesRelationV1[]): Uint8Array {
  return Buffer.from(`${JSON.stringify({
    schema: NOTE_RELATIONS_STORE_SCHEMA_V1,
    revision,
    relations: relations.map(canonicalRelation)
  }, null, 2)}\n`, "utf8");
}

function sameDirectoryIdentity(
  expected: NoteRelationsRootEvidence,
  actual: NoteRelationsRootEvidence
): boolean {
  return expected.rootState === "present"
    && actual.rootState === "present"
    && expected.homeIdentity.dev === actual.homeIdentity.dev
    && expected.homeIdentity.ino === actual.homeIdentity.ino
    && expected.homeIdentity.uid === actual.homeIdentity.uid
    && expected.rootIdentity.dev === actual.rootIdentity.dev
    && expected.rootIdentity.ino === actual.rootIdentity.ino
    && expected.rootIdentity.uid === actual.rootIdentity.uid
    && expected.rootIdentity.mode === actual.rootIdentity.mode
    && expected.rootIdentity.realpath === actual.rootIdentity.realpath;
}

async function removeOwnedTemp(path: string, identity: { readonly dev: number; readonly ino: number }): Promise<void> {
  try {
    const current = await fs.lstat(path);
    if (current.isFile() && !current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino) {
      await fs.unlink(path);
    }
  } catch {
    // Cleanup is best effort and never broadens the target beyond the verified temp.
  }
}

async function writeCanonicalStore(
  paths: NoteRelationsPathSnapshot,
  root: NoteRelationsRootEvidence,
  revision: number,
  relations: readonly SupersedesRelationV1[]
): Promise<void> {
  if (root.rootState !== "present") storeUnsafe();
  const bytes = canonicalStoreBytes(revision, relations);
  if (bytes.byteLength > MAX_STORE_BYTES) {
    throw new NoteRelationsStoreError("STORE_CORRUPT");
  }
  const temp = join(paths.museRoot, `.note-relations-${randomUUID()}.tmp`);
  const flags = fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | (fsConstants.O_NOFOLLOW ?? 0);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let identity: { readonly dev: number; readonly ino: number } | undefined;
  try {
    handle = await fs.open(temp, flags, 0o600);
    await handle.chmod(0o600);
    const opened = await handle.stat();
    assertPrivateRegularFile(opened as Awaited<ReturnType<typeof fs.lstat>>);
    identity = { dev: opened.dev, ino: opened.ino };
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;

    const beforeRename = await verifyNoteRelationsRoot(paths, { create: false });
    if (!sameDirectoryIdentity(root, beforeRename)) storeUnsafe();
    const tempStats = await fs.lstat(temp);
    if (!identity || !tempStats.isFile() || tempStats.isSymbolicLink()
      || tempStats.dev !== identity.dev || tempStats.ino !== identity.ino
      || (Number(tempStats.mode) & 0o777) !== 0o600) storeUnsafe();

    await fs.rename(temp, paths.storeFile);
    identity = undefined;
    const storedBytes = await readPrivateStoreFile(paths.storeFile);
    if (!storedBytes || !Buffer.from(storedBytes).equals(Buffer.from(bytes))) storeUnsafe();
    try {
      const directory = await fs.open(paths.museRoot, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch {
      // Some platforms do not support directory fsync after a durable file rename.
    }
  } finally {
    await handle?.close().catch(() => undefined);
    if (identity) await removeOwnedTemp(temp, identity);
  }
}

export async function mutateNoteRelationsStore(
  paths: NoteRelationsPathSnapshot,
  mutate: (current: ReadNoteRelationsStoreResult) => readonly SupersedesRelationV1[] | Promise<readonly SupersedesRelationV1[]>,
  options: { readonly expectedRoot?: NoteRelationsRootEvidence } = {}
): Promise<ReadNoteRelationsStoreResult> {
  return withFileMutationQueue(paths.storeFile, async () => {
    let root: NoteRelationsRootEvidence;
    try {
      const beforeCreate = await verifyNoteRelationsRoot(paths, { create: false });
      if (options.expectedRoot) {
        if (options.expectedRoot.rootState !== beforeCreate.rootState) {
          throw new NoteRelationsStoreError("STORE_IO");
        }
        if (options.expectedRoot.rootState === "present" && !sameDirectoryIdentity(options.expectedRoot, beforeCreate)) {
          throw new NoteRelationsStoreError("STORE_IO");
        }
        if (options.expectedRoot.homeIdentity.dev !== beforeCreate.homeIdentity.dev
          || options.expectedRoot.homeIdentity.ino !== beforeCreate.homeIdentity.ino
          || options.expectedRoot.homeIdentity.uid !== beforeCreate.homeIdentity.uid) {
          throw new NoteRelationsStoreError("STORE_IO");
        }
      }
      root = await verifyNoteRelationsRoot(paths, { create: true });
      return await withPrivateFileLock(paths.lockFile, async () => {
        const current = await readNoteRelationsStore(paths);
        if (current.revision === Number.MAX_SAFE_INTEGER) {
          throw new NoteRelationsStoreError("STORE_CORRUPT");
        }
        const proposed = await mutate(current);
        if (!Array.isArray(proposed) || proposed.length > MAX_STORE_RELATIONS) {
          throw new NoteRelationsStoreError("STORE_CORRUPT");
        }
        const parsed = proposed.map(parseStoredRelation);
        if (parsed.some((relation) => relation === undefined)) {
          throw new NoteRelationsStoreError("STORE_CORRUPT");
        }
        const relations = (parsed as SupersedesRelationV1[]).sort((left, right) => left.edgeId.localeCompare(right.edgeId));
        if (new Set(relations.map((relation) => relation.edgeId)).size !== relations.length) {
          throw new NoteRelationsStoreError("STORE_CORRUPT");
        }
        await writeCanonicalStore(paths, root, current.revision + 1, relations);
        return readNoteRelationsStore(paths);
      });
    } catch (cause) {
      if (cause instanceof NoteRelationsStoreError) throw cause;
      if (cause instanceof PrivateFileLockError) {
        throw new NoteRelationsStoreError(
          cause.code === "PRIVATE_FILE_LOCK_CONTENDED" ? "STORE_LOCKED" : "STORE_UNSAFE"
        );
      }
      throw new NoteRelationsStoreError("STORE_IO");
    }
  });
}
