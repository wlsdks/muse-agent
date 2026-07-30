// eslint-disable-next-line @typescript-eslint/ban-ts-comment -- Emitted JS validates its untyped protocol at runtime.
// @ts-nocheck
import { Buffer } from "node:buffer";
import {
  chmodSync,
  closeSync,
  lstatSync,
  openSync,
  realpathSync,
  statfsSync
} from "node:fs";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import process from "node:process";
import { setTimeout } from "node:timers";
import { parentPort, workerData } from "node:worker_threads";

const PROTOCOL_VERSION = 1;
const APPLICATION_ID = 0x4d414731;
const USER_VERSION = 1;
const MAX_ENVELOPE_BYTES = 2_097_152;
const MAX_PROJECTION_BYTES = 1_048_576;
const MAX_TEXT = 512;
const BUSY_TIMEOUT_MS = 1_000;
const OWNER_ONLY_MASK = 0o077;
const ALLOWED_ERROR_CODES = new Set([
  "CORRUPT_STORE",
  "FUTURE_STORE_STATE",
  "STORE_FAILURE",
  "UNSUPPORTED_STORE_PROFILE"
]);
const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;
const FILESYSTEMS = new Map([
  ["darwin", new Set([0x11n, 0x1an])], // HFS+, APFS
  ["linux", new Set([0xef53n, 0x58465342n, 0x9123683en, 0x794c7630n, 0x01021994n])]
]);
const CREATE_JOURNAL = `CREATE TABLE mag_projection_journal (
  source_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  commit_id TEXT NOT NULL,
  projection_json TEXT NOT NULL CHECK (length(projection_json) BETWEEN 1 AND ${MAX_PROJECTION_BYTES}),
  projection_fingerprint TEXT NOT NULL,
  PRIMARY KEY (source_id, thread_id, generation, commit_id)
) STRICT, WITHOUT ROWID`;
const CREATE_GENERATION_INDEX = `CREATE UNIQUE INDEX mag_projection_journal_generation
ON mag_projection_journal (source_id, thread_id, generation)`;
const CREATE_HEAD = `CREATE TABLE mag_projection_head (
  source_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  commit_id TEXT NOT NULL,
  PRIMARY KEY (source_id, thread_id),
  FOREIGN KEY (source_id, thread_id, generation, commit_id)
    REFERENCES mag_projection_journal (source_id, thread_id, generation, commit_id)
    ON UPDATE RESTRICT ON DELETE RESTRICT
) STRICT, WITHOUT ROWID`;

let database;
let statements;
let initialized = false;
let closing = false;
const TEST_FAULTS = new Set([
  "before-commit",
  "after-commit-before-ack",
  "hang-read",
  "hang-close"
]);
const testFault = TEST_FAULTS.has(workerData?.testFault)
  ? workerData.testFault
  : undefined;
const testFixtureMode = workerData?.testFixtureMode === true;
let lastRequestId = 0;

function fail(code, message, cause) {
  const error = new Error(message, cause === undefined ? undefined : { cause });
  error.magCode = code;
  throw error;
}

function plainRecord(value, label, allowed, required = allowed) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("STORE_FAILURE", `${label} must be a plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("STORE_FAILURE", `${label} must be a plain object`);
  }
  const keys = Object.keys(value);
  if (keys.length !== Reflect.ownKeys(value).length || keys.some((key) => !allowed.includes(key))) {
    fail("STORE_FAILURE", `${label} has unknown fields`);
  }
  if (required.some((key) => !Object.hasOwn(value, key))) {
    fail("STORE_FAILURE", `${label} has missing fields`);
  }
  return value;
}

function boundedText(value, label, limit = MAX_TEXT, code = "STORE_FAILURE") {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || value.length > limit
  ) {
    fail(code, `${label} must be bounded non-empty text`);
  }
  return value;
}

function safeInteger(value, label, minimum = 0n, code = "CORRUPT_STORE") {
  if (typeof value !== "bigint" || value < minimum || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail(code, `${label} is not a safe integer`);
  }
  return Number(value);
}

function serializedSize(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch (cause) {
    fail("STORE_FAILURE", "worker protocol envelope is not serializable", cause);
  }
}

function assertEnvelopeSize(value) {
  if (serializedSize(value) > MAX_ENVELOPE_BYTES) {
    fail("STORE_FAILURE", "worker protocol envelope is oversized");
  }
}

function validateScope(value, label = "scope") {
  const input = plainRecord(value, label, ["sourceId", "threadId"]);
  return {
    sourceId: boundedText(input.sourceId, `${label}.sourceId`),
    threadId: boundedText(input.threadId, `${label}.threadId`)
  };
}

function validateSnapshot(value, scope, label = "snapshot") {
  const input = plainRecord(value, label, ["schemaVersion", "scope", "generation", "commitId"]);
  const snapshotScope = validateScope(input.scope, `${label}.scope`);
  if (
    input.schemaVersion !== 1
    || !Number.isSafeInteger(input.generation)
    || input.generation < 1
    || snapshotScope.sourceId !== scope.sourceId
    || snapshotScope.threadId !== scope.threadId
  ) {
    fail("STORE_FAILURE", `${label} is invalid`);
  }
  return {
    schemaVersion: 1,
    scope: snapshotScope,
    generation: input.generation,
    commitId: boundedText(input.commitId, `${label}.commitId`)
  };
}

function validateProjection(value, scope) {
  const input = plainRecord(value, "proposed projection", [
    "schemaVersion",
    "snapshot",
    "observationId",
    "canonicalProjection",
    "projectionFingerprint",
    "observedAt",
    "sourceFreshness",
    "assertions"
  ]);
  const snapshot = validateSnapshot(input.snapshot, scope, "proposed projection.snapshot");
  const observationId = boundedText(input.observationId, "proposed projection.observationId");
  const fingerprint = boundedText(
    input.projectionFingerprint,
    "proposed projection.projectionFingerprint"
  );
  if (
    input.schemaVersion !== 1
    || observationId !== fingerprint
    || snapshot.commitId !== `mag-commit:${observationId}`
    || typeof input.canonicalProjection !== "string"
    || Buffer.byteLength(input.canonicalProjection, "utf8") > MAX_PROJECTION_BYTES
  ) {
    fail("STORE_FAILURE", "proposed projection is incoherent");
  }
  const json = JSON.stringify(input);
  if (Buffer.byteLength(json, "utf8") > MAX_PROJECTION_BYTES) {
    fail("STORE_FAILURE", "proposed projection exceeds the durable row bound");
  }
  return { projection: input, json, snapshot, fingerprint };
}

function assertNodeProfile() {
  const [major, minor, patch] = process.versions.node.split(".").map(Number);
  if (
    !Number.isInteger(major)
    || !Number.isInteger(minor)
    || !Number.isInteger(patch)
    || major < 24
    || (major === 24 && minor < 12)
  ) {
    fail("UNSUPPORTED_STORE_PROFILE", "local MAG requires Node >=24.12.0");
  }
}

function supportedSqliteVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const [, rawMajor, rawMinor, rawPatch] = match;
  const major = Number(rawMajor);
  const minor = Number(rawMinor);
  const patch = Number(rawPatch);
  return (
    (major === 3 && minor === 44 && patch >= 6)
    || (major === 3 && minor === 50 && patch >= 7)
    || (major === 3 && (minor > 51 || (minor === 51 && patch >= 3)))
  );
}

function assertOwnedRegularFile(path, allowAbsent) {
  let info;
  try {
    info = lstatSync(path, { bigint: true });
  } catch (cause) {
    if (allowAbsent && cause && cause.code === "ENOENT") return undefined;
    fail("UNSUPPORTED_STORE_PROFILE", "database file profile could not be inspected", cause);
  }
  if (
    info.isSymbolicLink()
    || !info.isFile()
    || info.uid !== BigInt(process.geteuid())
    || (Number(info.mode) & OWNER_ONLY_MASK) !== 0
  ) {
    fail("UNSUPPORTED_STORE_PROFILE", "database files must be regular, owner-only files");
  }
  return info;
}

function validateDatabasePath(value) {
  if (
    typeof value !== "string"
    || value.includes("\0")
    || value.startsWith("file:")
    || value === ":memory:"
    || !isAbsolute(value)
    || normalize(value) !== value
    || Buffer.byteLength(value, "utf8") > 4_096
  ) {
    fail("UNSUPPORTED_STORE_PROFILE", "databasePath must be a normalized absolute file path");
  }
  if (process.platform !== "darwin" && process.platform !== "linux") {
    fail("UNSUPPORTED_STORE_PROFILE", "the current operating system has no reviewed local profile");
  }
  const parent = dirname(value);
  let canonicalParent;
  try {
    canonicalParent = realpathSync(parent);
  } catch (cause) {
    fail("UNSUPPORTED_STORE_PROFILE", "database parent directory must already exist", cause);
  }
  if (canonicalParent !== parent) {
    fail(
      "UNSUPPORTED_STORE_PROFILE",
      "database path must not contain symlinked or noncanonical parent components"
    );
  }
  const canonicalDatabasePath = join(canonicalParent, basename(value));
  let parentInfo;
  try {
    parentInfo = lstatSync(canonicalParent, { bigint: true });
  } catch (cause) {
    fail("UNSUPPORTED_STORE_PROFILE", "database parent directory must already exist", cause);
  }
  if (!parentInfo.isDirectory()) {
    fail("UNSUPPORTED_STORE_PROFILE", "database parent must be a real directory");
  }
  const allowed = FILESYSTEMS.get(process.platform);
  let fileSystem;
  try {
    fileSystem = statfsSync(canonicalParent, { bigint: true });
  } catch (cause) {
    fail("UNSUPPORTED_STORE_PROFILE", "database filesystem could not be classified", cause);
  }
  if (!allowed?.has(fileSystem.type)) {
    fail("UNSUPPORTED_STORE_PROFILE", "database filesystem is not in the reviewed local allowlist");
  }
  const existing = assertOwnedRegularFile(canonicalDatabasePath, true);
  assertOwnedRegularFile(`${canonicalDatabasePath}-wal`, true);
  assertOwnedRegularFile(`${canonicalDatabasePath}-shm`, true);
  return {
    databasePath: canonicalDatabasePath,
    existed: existing !== undefined,
    wasEmpty: existing === undefined || existing.size === 0n
  };
}

function sqlitePrimaryCode(cause) {
  return cause && typeof cause === "object" && Number.isInteger(cause.errcode)
    ? cause.errcode & 0xff
    : undefined;
}

function mapSqliteFailure(cause, context, corruptionContext = false) {
  const primary = sqlitePrimaryCode(cause);
  if (primary === SQLITE_CORRUPT || primary === SQLITE_NOTADB || corruptionContext) {
    fail("CORRUPT_STORE", `${context}: durable SQLite state is corrupt`, cause);
  }
  fail("STORE_FAILURE", `${context} failed`, cause);
}

function execSql(sql, context, corruptionContext = false) {
  try {
    database.exec(sql);
  } catch (cause) {
    mapSqliteFailure(cause, context, corruptionContext);
  }
}

function getSql(statement, ...parameters) {
  try {
    return statement.get(...parameters);
  } catch (cause) {
    mapSqliteFailure(cause, "SQLite read");
  }
}

function allSql(statement, ...parameters) {
  try {
    return statement.all(...parameters);
  } catch (cause) {
    mapSqliteFailure(cause, "SQLite read");
  }
}

function runSql(statement, ...parameters) {
  try {
    return statement.run(...parameters);
  } catch (cause) {
    mapSqliteFailure(cause, "SQLite write");
  }
}

function pragmaInteger(name) {
  const row = getSql(database.prepare(`PRAGMA ${name}`));
  const value = row?.[name];
  return safeInteger(value, `PRAGMA ${name}`, 0n);
}

function normalizedSchemaSql(value) {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
}

function assertExactSchema() {
  const objects = allSql(database.prepare(
    "SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema "
      + "WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
  ));
  const expected = new Map([
    ["index:mag_projection_journal_generation", normalizedSchemaSql(CREATE_GENERATION_INDEX)],
    ["table:mag_projection_head", normalizedSchemaSql(CREATE_HEAD)],
    ["table:mag_projection_journal", normalizedSchemaSql(CREATE_JOURNAL)]
  ]);
  if (objects.length !== expected.size) {
    fail("CORRUPT_STORE", "local MAG schema has unexpected or missing objects");
  }
  for (const object of objects) {
    const key = `${object.type}:${object.name}`;
    if (
      typeof object.type !== "string"
      || typeof object.name !== "string"
      || typeof object.tableName !== "string"
      || normalizedSchemaSql(object.sql) !== expected.get(key)
    ) {
      fail("CORRUPT_STORE", "local MAG schema does not match physical profile v1");
    }
  }
  const foreignKeys = allSql(database.prepare("PRAGMA foreign_key_list(mag_projection_head)"));
  if (
    foreignKeys.length !== 4
    || foreignKeys.some((row) =>
      row.table !== "mag_projection_journal"
      || row.on_update !== "RESTRICT"
      || row.on_delete !== "RESTRICT"
      || row.match !== "NONE"
    )
  ) {
    fail("CORRUPT_STORE", "local MAG head foreign key is invalid");
  }
}

function assertDatabaseIntegrity() {
  const quick = getSql(database.prepare("PRAGMA quick_check"));
  if (quick?.quick_check !== "ok") {
    fail("CORRUPT_STORE", "SQLite quick_check did not pass");
  }
  assertExactSchema();
  const orphan = getSql(database.prepare(`
    SELECT COUNT(*) AS count
    FROM mag_projection_head AS h
    LEFT JOIN mag_projection_journal AS j
      ON j.source_id = h.source_id
      AND j.thread_id = h.thread_id
      AND j.generation = h.generation
      AND j.commit_id = h.commit_id
    WHERE j.source_id IS NULL
  `));
  if (safeInteger(orphan?.count, "orphan head count", 0n) !== 0) {
    fail("CORRUPT_STORE", "local MAG head does not identify an exact journal row");
  }
}

function initializeSchema(wasEmpty) {
  const applicationId = pragmaInteger("application_id");
  const userVersion = pragmaInteger("user_version");
  const objects = getSql(database.prepare(
    "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'"
  ));
  const objectCount = safeInteger(objects?.count, "schema object count", 0n);
  if (userVersion > USER_VERSION) {
    fail("FUTURE_STORE_STATE", "local MAG store has a future physical schema");
  }
  if (userVersion === 0) {
    if (!wasEmpty || applicationId !== 0 || objectCount !== 0) {
      fail("CORRUPT_STORE", "local MAG store has a nonempty or partial bootstrap state");
    }
    execSql("BEGIN IMMEDIATE", "schema transaction");
    try {
      execSql(CREATE_JOURNAL, "journal schema creation");
      execSql(CREATE_GENERATION_INDEX, "journal index creation");
      execSql(CREATE_HEAD, "head schema creation");
      execSql(`PRAGMA application_id = ${APPLICATION_ID}`);
      execSql(`PRAGMA user_version = ${USER_VERSION}`);
      execSql("COMMIT", "schema commit");
    } catch (cause) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // The original typed failure remains authoritative.
      }
      throw cause;
    }
  } else if (userVersion !== USER_VERSION || applicationId !== APPLICATION_ID) {
    fail("CORRUPT_STORE", "local MAG store has a foreign physical identity");
  }
}

function assertSidecars(databasePath) {
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    try {
      chmodSync(path, 0o600);
    } catch (cause) {
      if (cause?.code !== "ENOENT") {
        fail("UNSUPPORTED_STORE_PROFILE", "database file permissions could not be secured", cause);
      }
    }
  }
  assertOwnedRegularFile(databasePath, false);
  assertOwnedRegularFile(`${databasePath}-wal`, true);
  assertOwnedRegularFile(`${databasePath}-shm`, true);
}

function prepareStatements() {
  return {
    read: database.prepare(`
      SELECT j.generation, j.commit_id AS commitId, j.projection_json AS projectionJson,
             j.projection_fingerprint AS projectionFingerprint
      FROM mag_projection_head AS h
      JOIN mag_projection_journal AS j
        ON j.source_id = h.source_id
        AND j.thread_id = h.thread_id
        AND j.generation = h.generation
        AND j.commit_id = h.commit_id
      WHERE h.source_id = ? AND h.thread_id = ?
    `),
    current: database.prepare(`
      SELECT generation, commit_id AS commitId
      FROM mag_projection_head
      WHERE source_id = ? AND thread_id = ?
    `),
    insertJournal: database.prepare(`
      INSERT INTO mag_projection_journal (
        source_id, thread_id, generation, commit_id, projection_json, projection_fingerprint
      ) VALUES (?, ?, ?, ?, ?, ?)
    `),
    insertHead: database.prepare(`
      INSERT INTO mag_projection_head (source_id, thread_id, generation, commit_id)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (source_id, thread_id) DO UPDATE SET
        generation = excluded.generation,
        commit_id = excluded.commit_id
    `)
  };
}

async function initialize(payload) {
  if (initialized || closing) fail("STORE_FAILURE", "worker is already initialized");
  const input = plainRecord(payload, "initialize payload", ["databasePath"]);
  assertNodeProfile();
  const pathProfile = validateDatabasePath(input.databasePath);
  let sqlite;
  try {
    sqlite = await import("node:sqlite");
  } catch (cause) {
    fail("UNSUPPORTED_STORE_PROFILE", "node:sqlite is unavailable in this runtime", cause);
  }
  const DatabaseSync = sqlite.DatabaseSync;
  if (typeof DatabaseSync !== "function") {
    fail("UNSUPPORTED_STORE_PROFILE", "node:sqlite DatabaseSync is unavailable");
  }
  let probe;
  try {
    probe = new DatabaseSync(":memory:", {
      allowExtension: false,
      defensive: true,
      enableDoubleQuotedStringLiterals: false,
      readBigInts: true,
      timeout: BUSY_TIMEOUT_MS
    });
    for (const capability of ["close", "enableDefensive", "enableLoadExtension", "exec", "prepare"]) {
      if (typeof probe[capability] !== "function") {
        fail("UNSUPPORTED_STORE_PROFILE", `node:sqlite is missing ${capability}`);
      }
    }
    const statement = probe.prepare("SELECT sqlite_version() AS version");
    if (
      typeof statement.get !== "function"
      || typeof statement.all !== "function"
      || typeof statement.run !== "function"
    ) {
      fail("UNSUPPORTED_STORE_PROFILE", "node:sqlite StatementSync capabilities are incomplete");
    }
    const version = statement.get()?.version;
    if (typeof version !== "string" || !supportedSqliteVersion(version)) {
      fail("UNSUPPORTED_STORE_PROFILE", `SQLite ${String(version)} is outside the reviewed WAL profile`);
    }
    probe.exec("CREATE TABLE profile_probe (id INTEGER PRIMARY KEY) STRICT; INSERT INTO profile_probe VALUES (1)");
    try {
      probe.exec("INSERT INTO profile_probe VALUES (1)");
      fail("UNSUPPORTED_STORE_PROFILE", "node:sqlite numeric error contract probe did not fail");
    } catch (cause) {
      if (cause?.magCode) throw cause;
      if (!Number.isInteger(cause?.errcode)) {
        fail("UNSUPPORTED_STORE_PROFILE", "node:sqlite numeric error contract is unavailable", cause);
      }
    }
  } finally {
    try {
      probe?.close();
    } catch {
      // The capability handshake outcome remains authoritative.
    }
  }

  if (!pathProfile.existed) {
    let descriptor;
    try {
      descriptor = openSync(pathProfile.databasePath, "wx", 0o600);
    } catch (cause) {
      fail("STORE_FAILURE", "database file could not be created safely", cause);
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  }
  try {
    database = new DatabaseSync(pathProfile.databasePath, {
      allowExtension: false,
      defensive: true,
      enableDoubleQuotedStringLiterals: false,
      readBigInts: true,
      timeout: BUSY_TIMEOUT_MS
    });
    database.enableDefensive(true);
    database.enableLoadExtension(false);
    execSql("PRAGMA foreign_keys = ON");
    execSql("PRAGMA trusted_schema = OFF");
    execSql("PRAGMA synchronous = FULL");
    initializeSchema(pathProfile.wasEmpty);
    const journalMode = getSql(database.prepare("PRAGMA journal_mode = WAL"))?.journal_mode;
    if (journalMode !== "wal") {
      fail("UNSUPPORTED_STORE_PROFILE", "SQLite WAL mode could not be established");
    }
    execSql("PRAGMA synchronous = FULL");
    assertSidecars(pathProfile.databasePath);
    if (
      getSql(database.prepare("PRAGMA foreign_keys"))?.foreign_keys !== 1n
      || getSql(database.prepare("PRAGMA trusted_schema"))?.trusted_schema !== 0n
      || getSql(database.prepare("PRAGMA synchronous"))?.synchronous !== 2n
    ) {
      fail("UNSUPPORTED_STORE_PROFILE", "SQLite safety pragmas could not be established");
    }
    assertDatabaseIntegrity();
    statements = prepareStatements();
    initialized = true;
    return {
      applicationId: APPLICATION_ID,
      profileVersion: 1,
      protocolVersion: PROTOCOL_VERSION,
      sqliteVersion: process.versions.sqlite,
      userVersion: USER_VERSION
    };
  } catch (cause) {
    try {
      database?.close();
    } catch {
      // The initialization failure remains authoritative.
    }
    database = undefined;
    if (cause?.magCode) throw cause;
    mapSqliteFailure(cause, "SQLite initialization");
  }
}

function assertReady() {
  if (!initialized || !database || !statements || closing) {
    fail("STORE_FAILURE", "worker store is not open");
  }
}

function decodeStoredProjection(row, scope) {
  const generation = safeInteger(row.generation, "journal generation", 1n);
  const commitId = boundedText(row.commitId, "journal commit", MAX_TEXT, "CORRUPT_STORE");
  const fingerprint = boundedText(
    row.projectionFingerprint,
    "journal fingerprint",
    MAX_TEXT,
    "CORRUPT_STORE"
  );
  if (
    typeof row.projectionJson !== "string"
    || Buffer.byteLength(row.projectionJson, "utf8") > MAX_PROJECTION_BYTES
  ) {
    fail("CORRUPT_STORE", "journal projection payload is oversized or invalid");
  }
  let projection;
  try {
    projection = JSON.parse(row.projectionJson);
  } catch (cause) {
    fail("CORRUPT_STORE", "journal projection payload is malformed JSON", cause);
  }
  if (JSON.stringify(projection) !== row.projectionJson) {
    fail("CORRUPT_STORE", "journal projection payload is not canonical JSON");
  }
  const snapshot = projection?.snapshot;
  if (
    projection?.schemaVersion !== 1
    || snapshot?.schemaVersion !== 1
    || snapshot?.scope?.sourceId !== scope.sourceId
    || snapshot?.scope?.threadId !== scope.threadId
    || snapshot?.generation !== generation
    || snapshot?.commitId !== commitId
    || projection?.projectionFingerprint !== fingerprint
  ) {
    fail("CORRUPT_STORE", "journal payload does not match its physical identity");
  }
  return projection;
}

function read(payload) {
  assertReady();
  if (testFault === "hang-read") {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
  }
  const input = plainRecord(payload, "read payload", ["scope"]);
  const scope = validateScope(input.scope);
  const rows = allSql(statements.read, scope.sourceId, scope.threadId);
  if (rows.length > 1) fail("CORRUPT_STORE", "scope has more than one head");
  if (rows.length === 0) {
    if (currentSnapshot(scope) !== undefined) {
      fail("CORRUPT_STORE", "scope head does not identify an exact journal row");
    }
    return { found: false };
  }
  return { found: true, projection: decodeStoredProjection(rows[0], scope) };
}

function currentSnapshot(scope) {
  const rows = allSql(statements.current, scope.sourceId, scope.threadId);
  if (rows.length > 1) fail("CORRUPT_STORE", "scope has more than one head");
  if (rows.length === 0) return undefined;
  return {
    schemaVersion: 1,
    scope,
    generation: safeInteger(rows[0].generation, "head generation", 1n),
    commitId: boundedText(rows[0].commitId, "head commit", MAX_TEXT, "CORRUPT_STORE")
  };
}

function sameSnapshot(left, right) {
  return (
    left?.schemaVersion === right?.schemaVersion
    && left?.generation === right?.generation
    && left?.commitId === right?.commitId
    && left?.scope.sourceId === right?.scope.sourceId
    && left?.scope.threadId === right?.scope.threadId
  );
}

function compareAndSwap(payload) {
  assertReady();
  const input = plainRecord(payload, "compare-and-swap payload", [
    "scope",
    "expected",
    "proposed"
  ]);
  const scope = validateScope(input.scope);
  const expected = input.expected === null
    ? undefined
    : validateSnapshot(input.expected, scope, "expected snapshot");
  const proposed = validateProjection(input.proposed, scope);
  execSql("BEGIN IMMEDIATE", "compare-and-swap begin");
  try {
    const current = currentSnapshot(scope);
    if (!sameSnapshot(current, expected)) {
      execSql("ROLLBACK", "compare-and-swap rollback");
      return { committed: false };
    }
    if (
      proposed.snapshot.generation !== (current?.generation ?? 0) + 1
      || proposed.snapshot.scope.sourceId !== scope.sourceId
      || proposed.snapshot.scope.threadId !== scope.threadId
    ) {
      fail("STORE_FAILURE", "proposed snapshot does not advance the pinned head exactly once");
    }
    runSql(
      statements.insertJournal,
      scope.sourceId,
      scope.threadId,
      BigInt(proposed.snapshot.generation),
      proposed.snapshot.commitId,
      proposed.json,
      proposed.fingerprint
    );
    runSql(
      statements.insertHead,
      scope.sourceId,
      scope.threadId,
      BigInt(proposed.snapshot.generation),
      proposed.snapshot.commitId
    );
    if (testFault === "before-commit") process.exit(71);
    execSql("COMMIT", "compare-and-swap commit");
    if (testFault === "after-commit-before-ack") process.exit(72);
    return { committed: true };
  } catch (cause) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Preserve the typed transaction failure.
    }
    throw cause;
  }
}

function closeStore(payload) {
  plainRecord(payload, "close payload", []);
  if (testFault === "hang-close") {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
  }
  if (closing) return { closed: true };
  closing = true;
  if (database) {
    try {
      const row = database.prepare("PRAGMA wal_checkpoint(PASSIVE)").get();
      safeInteger(row?.busy, "checkpoint busy", 0n, "STORE_FAILURE");
      safeInteger(row?.log, "checkpoint log", -1n, "STORE_FAILURE");
      safeInteger(row?.checkpointed, "checkpoint completed", -1n, "STORE_FAILURE");
    } catch (cause) {
      if (cause?.magCode) throw cause;
      mapSqliteFailure(cause, "PASSIVE checkpoint");
    } finally {
      try {
        database.close();
      } catch (cause) {
        mapSqliteFailure(cause, "SQLite close");
      }
      database = undefined;
      statements = undefined;
      initialized = false;
    }
  }
  return { closed: true };
}

function holdWriteLockForTesting(payload) {
  assertReady();
  if (!testFixtureMode) fail("STORE_FAILURE", "worker test fixture mode is disabled");
  const input = plainRecord(payload, "lock fixture payload", ["durationMs"]);
  if (
    !Number.isSafeInteger(input.durationMs)
    || input.durationMs < 1_100
    || input.durationMs > 5_000
  ) {
    fail("STORE_FAILURE", "lock fixture duration is invalid");
  }
  execSql("BEGIN IMMEDIATE", "lock fixture begin");
  setTimeout(() => {
    try {
      database?.exec("ROLLBACK");
    } catch {
      // Test-only lock cleanup is verified by the competing operation.
    }
  }, input.durationMs).unref();
  return { acquired: true };
}

function inspectForTesting(payload) {
  assertReady();
  if (!testFixtureMode) fail("STORE_FAILURE", "worker test fixture mode is disabled");
  plainRecord(payload, "inspection payload", []);
  const row = getSql(database.prepare(`
    SELECT
      (SELECT COUNT(*) FROM mag_projection_head) AS headRows,
      (SELECT COUNT(*) FROM mag_projection_journal) AS journalRows,
      COALESCE((SELECT MAX(generation) FROM mag_projection_journal), 0) AS maxGeneration
  `));
  return {
    headRows: safeInteger(row?.headRows, "inspection head count", 0n),
    journalRows: safeInteger(row?.journalRows, "inspection journal count", 0n),
    maxGeneration: safeInteger(row?.maxGeneration, "inspection max generation", 0n)
  };
}

function mutateForTesting(payload) {
  assertReady();
  if (!testFixtureMode) fail("STORE_FAILURE", "worker test fixture mode is disabled");
  const input = plainRecord(payload, "test mutation payload", ["mutation"]);
  switch (input.mutation) {
    case "future-user-version":
      execSql("PRAGMA user_version = 2", "future-version test mutation");
      break;
    case "wrong-application-id":
      execSql("PRAGMA application_id = 1", "application-id test mutation");
      break;
    case "malformed-projection-json":
      runSql(database.prepare(
        "UPDATE mag_projection_journal SET projection_json = '{' "
          + "WHERE (source_id, thread_id, generation) IN "
          + "(SELECT source_id, thread_id, generation FROM mag_projection_head)"
      ));
      break;
    case "missing-journal-row":
      execSql("PRAGMA foreign_keys = OFF", "disable foreign keys for test mutation");
      runSql(database.prepare(
        "DELETE FROM mag_projection_journal "
          + "WHERE (source_id, thread_id, generation) IN "
          + "(SELECT source_id, thread_id, generation FROM mag_projection_head)"
      ));
      execSql("PRAGMA foreign_keys = ON", "restore foreign keys after test mutation");
      break;
    case "partial-bootstrap":
      execSql("PRAGMA application_id = 0", "partial-bootstrap application mutation");
      execSql("PRAGMA user_version = 0", "partial-bootstrap version mutation");
      break;
    case "oversized-projection-json":
      execSql(
        "PRAGMA ignore_check_constraints = ON",
        "disable check constraints for oversized-row test"
      );
      try {
        runSql(
          database.prepare(
            "UPDATE mag_projection_journal SET projection_json = ? "
              + "WHERE (source_id, thread_id, generation) IN "
              + "(SELECT source_id, thread_id, generation FROM mag_projection_head)"
          ),
          "x".repeat(MAX_PROJECTION_BYTES + 1)
        );
      } finally {
        execSql(
          "PRAGMA ignore_check_constraints = OFF",
          "restore check constraints after oversized-row test"
        );
      }
      break;
    case "mismatched-head":
      execSql("PRAGMA foreign_keys = OFF", "disable foreign keys for mismatched-head test");
      runSql(database.prepare(
        "UPDATE mag_projection_head SET commit_id = 'mismatched-head'"
      ));
      execSql("PRAGMA foreign_keys = ON", "restore foreign keys after mismatched-head test");
      break;
    case "quick-check-corruption":
      database.enableDefensive(false);
      try {
        execSql("PRAGMA writable_schema = ON", "enable writable schema for corruption test");
        runSql(database.prepare(
          "UPDATE sqlite_schema SET rootpage = 2147483647 "
            + "WHERE name = 'mag_projection_journal'"
        ));
        execSql("PRAGMA writable_schema = OFF", "disable writable schema after corruption test");
      } finally {
        database.enableDefensive(true);
      }
      break;
    default:
      fail("STORE_FAILURE", "worker test mutation is unknown");
  }
  return { mutated: true };
}

async function dispatch(request) {
  switch (request.type) {
    case "initialize":
      return initialize(request.payload);
    case "read":
      return read(request.payload);
    case "compareAndSwap":
      return compareAndSwap(request.payload);
    case "holdWriteLockForTesting":
      return holdWriteLockForTesting(request.payload);
    case "inspectForTesting":
      return inspectForTesting(request.payload);
    case "mutateForTesting":
      return mutateForTesting(request.payload);
    case "close":
      return closeStore(request.payload);
    default:
      fail("STORE_FAILURE", "worker protocol request type is unknown");
  }
}

function errorEnvelope(id, cause) {
  const code = ALLOWED_ERROR_CODES.has(cause?.magCode) ? cause.magCode : "STORE_FAILURE";
  const message = typeof cause?.message === "string" && cause.message.length <= 1_024
    ? cause.message
    : "local MAG worker failed";
  return { protocolVersion: PROTOCOL_VERSION, id, ok: false, error: { code, message } };
}

if (!parentPort) {
  throw new Error("local MAG SQLite worker requires a parent port");
}

parentPort.on("message", async (message) => {
  let id = Number.isSafeInteger(message?.id) && message.id > 0 ? message.id : 0;
  try {
    assertEnvelopeSize(message);
    const request = plainRecord(message, "worker request", [
      "protocolVersion",
      "id",
      "type",
      "payload"
    ]);
    if (
      request.protocolVersion !== PROTOCOL_VERSION
      || !Number.isSafeInteger(request.id)
      || request.id < 1
      || typeof request.type !== "string"
    ) {
      fail("STORE_FAILURE", "worker protocol request is invalid");
    }
    id = request.id;
    if (id <= lastRequestId) {
      fail("STORE_FAILURE", "worker protocol request ID is not monotonic");
    }
    lastRequestId = id;
    const result = await dispatch(request);
    const response = { protocolVersion: PROTOCOL_VERSION, id, ok: true, result };
    assertEnvelopeSize(response);
    parentPort.postMessage(response);
    if (request.type === "close") parentPort.close();
  } catch (cause) {
    try {
      parentPort.postMessage(errorEnvelope(id, cause));
    } finally {
      if (message?.type === "initialize" || message?.type === "close") {
        try {
          database?.close();
        } catch {
          // The reported typed failure remains authoritative.
        }
        parentPort.close();
      }
    }
  }
});
