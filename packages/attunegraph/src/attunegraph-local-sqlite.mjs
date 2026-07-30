import { Buffer } from "node:buffer";
import { closeSync, openSync } from "node:fs";
import process from "node:process";
import { setTimeout } from "node:timers";
import { types as nodeTypes } from "node:util";
import { isMainThread, workerData } from "node:worker_threads";
import {
  APPLICATION_ID,
  PROTOCOL_VERSION,
  USER_VERSION,
  boundedText,
  fail,
  parseScope,
  parseSnapshot,
  plainRecord
} from "./attunegraph-local-protocol.mjs";
import {
  ATTUNEGRAPH_PHYSICAL_SCHEMA_V1,
  classifyAttuneGraphPhysicalSchemaV1
} from "./attunegraph-physical-schema-v1.mjs";
import { parseProjection } from "./attunegraph-local-projection.mjs";
import {
  assertNodeProfile,
  assertSidecars,
  supportedSqliteVersion,
  validateDatabasePath
} from "./attunegraph-local-profile.mjs";

const MAX_PROJECTION_BYTES = ATTUNEGRAPH_PHYSICAL_SCHEMA_V1.maxProjectionBytes;
const MAX_TEXT = 512;
const MAX_SCHEMA_SQL_BYTES = 4_096;
const BUSY_TIMEOUT_MS = 1_000;
const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;
/** @type {import("node:sqlite").DatabaseSync} */
let database;
/** @type {ReturnType<typeof prepareStatements>} */
let statements;
let initialized = false;
let closing = false;
/** @typedef {"before-commit" | "after-commit-before-ack" | "hang-read" | "hang-close"} TestFault */
const TEST_FAULTS = /** @type {ReadonlySet<TestFault>} */ (new Set([
  "before-commit",
  "after-commit-before-ack",
  "hang-read",
  "hang-close"
]));

/** @param {unknown} value @returns {{ readonly testFault: TestFault | undefined, readonly testFixtureMode: boolean }} */
function parseWorkerConfig(value) {
  if (value === undefined) {
    return Object.freeze({ testFault: undefined, testFixtureMode: false });
  }
  const input = plainRecord(value, "workerData", ["testFault", "testFixtureMode"], []);
  if (
    input.testFault !== undefined
    && (
      typeof input.testFault !== "string"
      || !TEST_FAULTS.has(/** @type {TestFault} */ (input.testFault))
    )
  ) fail("STORE_FAILURE", "workerData.testFault is invalid");
  if (input.testFixtureMode !== undefined && typeof input.testFixtureMode !== "boolean") {
    fail("STORE_FAILURE", "workerData.testFixtureMode is invalid");
  }
  return Object.freeze({
    testFault: /** @type {TestFault | undefined} */ (input.testFault),
    testFixtureMode: input.testFixtureMode === true
  });
}

const workerConfig = parseWorkerConfig(/** @type {unknown} */ (workerData));
const { testFault, testFixtureMode } = workerConfig;
/** @param {unknown} value @param {string} label @param {bigint} [minimum] @param {import("./attunegraph-local-protocol.mjs").SerializedErrorCode} [code] */
function safeInteger(value, label, minimum = 0n, code = "CORRUPT_STORE") {
  if (typeof value !== "bigint" || value < minimum || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail(code, `${label} is not a safe integer`);
  }
  return Number(value);
}

/** @param {unknown} value @param {import("./attunegraph-contracts.js").AttuneGraphScope} scope */
function validateProjection(value, scope) {
  const projection = parseProjection(value, scope);
  const { snapshot } = projection;
  const fingerprint = projection.projectionFingerprint;
  if (
    Buffer.byteLength(projection.canonicalProjection, "utf8") > MAX_PROJECTION_BYTES
  ) {
    fail("STORE_FAILURE", "proposed projection is incoherent");
  }
  const json = JSON.stringify(projection);
  if (Buffer.byteLength(json, "utf8") > MAX_PROJECTION_BYTES) {
    fail("STORE_FAILURE", "proposed projection exceeds the durable row bound");
  }
  return { projection, json, snapshot, fingerprint };
}


/** @param {unknown} cause */
function sqlitePrimaryCode(cause) {
  if (cause === null || typeof cause !== "object" || nodeTypes.isProxy(cause)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(cause, "errcode");
  if (
    descriptor === undefined
    || !Object.hasOwn(descriptor, "value")
    || !Number.isInteger(descriptor.value)
  ) return undefined;
  return /** @type {number} */ (descriptor.value) & 0xff;
}

/** @param {unknown} cause @param {string} context @param {boolean} [corruptionContext] @returns {never} */
function mapSqliteFailure(cause, context, corruptionContext = false) {
  const primary = sqlitePrimaryCode(cause);
  if (primary === SQLITE_CORRUPT || primary === SQLITE_NOTADB || corruptionContext) {
    fail("CORRUPT_STORE", `${context}: durable SQLite state is corrupt`, cause);
  }
  fail("STORE_FAILURE", `${context} failed`, cause);
}

/** @param {string} sql @param {string} [context] @param {boolean} [corruptionContext] */
function execSql(sql, context = "SQLite statement", corruptionContext = false) {
  try {
    database.exec(sql);
  } catch (cause) {
    mapSqliteFailure(cause, context, corruptionContext);
  }
}

/** @param {unknown} value @param {string} label @param {readonly string[]} allowed @param {import("./attunegraph-local-protocol.mjs").SerializedErrorCode} [code] */
function sqlRow(value, label, allowed, code = "STORE_FAILURE") {
  try {
    return plainRecord(value, label, allowed);
  } catch (cause) {
    fail(code, `${label} is invalid`, cause);
  }
}

/** @param {unknown} value @param {string} label @param {readonly string[]} allowed @param {import("./attunegraph-local-protocol.mjs").SerializedErrorCode} [code] */
function sqlRows(value, label, allowed, code = "STORE_FAILURE") {
  if (nodeTypes.isProxy(value) || !Array.isArray(value)) {
    fail(code, `${label} must be a row array`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(value).filter((key) => key !== "length");
  if (
    keys.length !== value.length
    || keys.some((key, index) => key !== String(index))
  ) fail(code, `${label} must be a dense row array`);
  return keys.map((key, index) => {
    const descriptor = descriptors[/** @type {string} */ (key)];
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !Object.hasOwn(descriptor, "value")
    ) fail(code, `${label}[${index}] must be a data row`);
    return sqlRow(descriptor.value, `${label}[${index}]`, allowed, code);
  });
}

/** @param {import("node:sqlite").StatementSync} statement @param {import("node:sqlite").SQLInputValue[]} parameters @returns {unknown} */
function getSql(statement, ...parameters) {
  try {
    return statement.get(...parameters);
  } catch (cause) {
    mapSqliteFailure(cause, "SQLite read");
  }
}

/** @param {import("node:sqlite").StatementSync} statement @param {import("node:sqlite").SQLInputValue[]} parameters @returns {unknown} */
function allSql(statement, ...parameters) {
  try {
    return statement.all(...parameters);
  } catch (cause) {
    mapSqliteFailure(cause, "SQLite read");
  }
}

/** @param {import("node:sqlite").StatementSync} statement @param {import("node:sqlite").SQLInputValue[]} parameters @returns {void} */
function runSql(statement, ...parameters) {
  try {
    const result = sqlRow(
      /** @type {unknown} */ (statement.run(...parameters)),
      "SQLite write result",
      ["changes", "lastInsertRowid"]
    );
    safeInteger(result.changes, "SQLite write changes", 0n, "STORE_FAILURE");
    safeInteger(result.lastInsertRowid, "SQLite write last insert rowid", 0n, "STORE_FAILURE");
  } catch (cause) {
    mapSqliteFailure(cause, "SQLite write");
  }
}

/** @param {"application_id" | "user_version"} name */
function pragmaInteger(name) {
  const row = sqlRow(getSql(database.prepare(`PRAGMA ${name}`)), `PRAGMA ${name} row`, [name]);
  const value = row[name];
  return safeInteger(value, `PRAGMA ${name}`, 0n);
}

/** @param {unknown} value @param {number} maximum */
function physicalText(value, maximum) {
  if (
    typeof value !== "string"
    || value.length === 0
    || Buffer.byteLength(value, "utf8") > maximum
  ) {
    fail("CORRUPT_STORE", "local AttuneGraph physical metadata is invalid");
  }
  return value;
}

/** @param {number} applicationId @param {number} userVersion */
function assertExactSchema(applicationId, userVersion) {
  const objects = sqlRows(allSql(database.prepare(
    "SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema "
      + "WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name LIMIT 4"
  )), "schema object rows", ["type", "name", "tableName", "sql"], "CORRUPT_STORE");
  if (objects.length === 4) {
    fail("CORRUPT_STORE", "local AttuneGraph schema has unexpected or missing objects");
  }
  const admittedObjects = Object.freeze(objects.map((object) => Object.freeze({
    type: physicalText(object.type, MAX_TEXT),
    name: physicalText(object.name, MAX_TEXT),
    tableName: physicalText(object.tableName, MAX_TEXT),
    normalizedSql: physicalText(object.sql, MAX_SCHEMA_SQL_BYTES)
      .replace(/\s+/g, " ")
      .trim()
  })));
  const foreignKeys = sqlRows(
    allSql(database.prepare(`
      SELECT id, seq, "table" AS "table", "from" AS "from", "to" AS "to",
             on_update AS onUpdate, on_delete AS onDelete, match
      FROM pragma_foreign_key_list('attunegraph_projection_head')
      ORDER BY id, seq
      LIMIT 5
    `)),
    "head foreign key rows",
    ["id", "seq", "table", "from", "to", "onUpdate", "onDelete", "match"],
    "CORRUPT_STORE"
  );
  if (foreignKeys.length === 5) fail("CORRUPT_STORE", "local AttuneGraph head foreign key is invalid");
  const admittedForeignKeys = Object.freeze(foreignKeys.map((row) => Object.freeze({
    id: safeInteger(row.id, "head foreign key id", 0n),
    seq: safeInteger(row.seq, "head foreign key sequence", 0n),
    table: physicalText(row.table, MAX_TEXT),
    from: physicalText(row.from, MAX_TEXT),
    to: physicalText(row.to, MAX_TEXT),
    onUpdate: physicalText(row.onUpdate, MAX_TEXT),
    onDelete: physicalText(row.onDelete, MAX_TEXT),
    match: physicalText(row.match, MAX_TEXT)
  })));
  const classification = classifyAttuneGraphPhysicalSchemaV1(Object.freeze({
    applicationId,
    userVersion,
    objects: admittedObjects,
    headForeignKey: admittedForeignKeys
  }));
  if (classification.kind === "future") {
    fail("FUTURE_STORE_STATE", "local AttuneGraph store has a future physical schema");
  }
  if (classification.kind !== "match") {
    fail("CORRUPT_STORE", "local AttuneGraph schema does not match physical profile v1");
  }
}

/** @param {{ readonly applicationId: number, readonly userVersion: number }} physicalIdentity */
function assertDatabaseIntegrity(physicalIdentity) {
  const quick = sqlRow(
    getSql(database.prepare("PRAGMA quick_check")),
    "quick-check row",
    ["quick_check"],
    "CORRUPT_STORE"
  );
  if (quick.quick_check !== "ok") {
    fail("CORRUPT_STORE", "SQLite quick_check did not pass");
  }
  assertExactSchema(physicalIdentity.applicationId, physicalIdentity.userVersion);
  const orphan = sqlRow(getSql(database.prepare(`
    SELECT COUNT(*) AS count
    FROM attunegraph_projection_head AS h
    LEFT JOIN attunegraph_projection_journal AS j
      ON j.source_id = h.source_id
      AND j.thread_id = h.thread_id
      AND j.generation = h.generation
      AND j.commit_id = h.commit_id
    WHERE j.source_id IS NULL
  `)), "orphan head row", ["count"], "CORRUPT_STORE");
  if (safeInteger(orphan.count, "orphan head count", 0n) !== 0) {
    fail("CORRUPT_STORE", "local AttuneGraph head does not identify an exact journal row");
  }
}

/** @param {boolean} wasEmpty */
function initializeSchema(wasEmpty) {
  const applicationId = pragmaInteger("application_id");
  const userVersion = pragmaInteger("user_version");
  const objects = sqlRow(getSql(database.prepare(
    "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'"
  )), "schema count row", ["count"], "CORRUPT_STORE");
  const objectCount = safeInteger(objects.count, "schema object count", 0n);
  if (userVersion === 0) {
    if (!wasEmpty || applicationId !== 0 || objectCount !== 0) {
      fail("CORRUPT_STORE", "local AttuneGraph store has a nonempty or partial bootstrap state");
    }
    execSql("BEGIN IMMEDIATE", "schema transaction");
    try {
      execSql(ATTUNEGRAPH_PHYSICAL_SCHEMA_V1.createJournal, "journal schema creation");
      execSql(ATTUNEGRAPH_PHYSICAL_SCHEMA_V1.createGenerationIndex, "journal index creation");
      execSql(ATTUNEGRAPH_PHYSICAL_SCHEMA_V1.createHead, "head schema creation");
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
    return Object.freeze({
      applicationId: ATTUNEGRAPH_PHYSICAL_SCHEMA_V1.applicationId,
      userVersion: ATTUNEGRAPH_PHYSICAL_SCHEMA_V1.userVersion
    });
  }
  if (userVersion > USER_VERSION) {
    fail("FUTURE_STORE_STATE", "local AttuneGraph store has a future physical schema");
  }
  if (applicationId === 0x4d414731) {
    fail(
      "INCOMPATIBLE_STORE_PROFILE",
      "local AttuneGraph store uses an incompatible physical identity"
    );
  }
  if (
    applicationId !== ATTUNEGRAPH_PHYSICAL_SCHEMA_V1.applicationId
    || userVersion !== ATTUNEGRAPH_PHYSICAL_SCHEMA_V1.userVersion
  ) {
    fail("CORRUPT_STORE", "local AttuneGraph store has a foreign physical identity");
  }
  return Object.freeze({ applicationId, userVersion });
}

function prepareStatements() {
  return {
    read: database.prepare(`
      SELECT j.generation, j.commit_id AS commitId, j.projection_json AS projectionJson,
             j.projection_fingerprint AS projectionFingerprint
      FROM attunegraph_projection_head AS h
      JOIN attunegraph_projection_journal AS j
        ON j.source_id = h.source_id
        AND j.thread_id = h.thread_id
        AND j.generation = h.generation
        AND j.commit_id = h.commit_id
      WHERE h.source_id = ? AND h.thread_id = ?
    `),
    current: database.prepare(`
      SELECT generation, commit_id AS commitId
      FROM attunegraph_projection_head
      WHERE source_id = ? AND thread_id = ?
    `),
    insertJournal: database.prepare(`
      INSERT INTO attunegraph_projection_journal (
        source_id, thread_id, generation, commit_id, projection_json, projection_fingerprint
      ) VALUES (?, ?, ?, ?, ?, ?)
    `),
    insertHead: database.prepare(`
      INSERT INTO attunegraph_projection_head (source_id, thread_id, generation, commit_id)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (source_id, thread_id) DO UPDATE SET
        generation = excluded.generation,
        commit_id = excluded.commit_id
    `)
  };
}

/** @param {import("./attunegraph-local-protocol.mjs").InitializePayload} payload @returns {Promise<import("./attunegraph-local-protocol.mjs").InitializeResult>} */
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
      if (!(capability in probe) || typeof Reflect.get(probe, capability) !== "function") {
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
    const versionRow = sqlRow(
      /** @type {unknown} */ (statement.get()),
      "SQLite version row",
      ["version"]
    );
    const version = versionRow.version;
    if (typeof version !== "string" || !supportedSqliteVersion(version)) {
      fail("UNSUPPORTED_STORE_PROFILE", `SQLite ${String(version)} is outside the reviewed WAL profile`);
    }
    probe.exec("CREATE TABLE profile_probe (id INTEGER PRIMARY KEY) STRICT; INSERT INTO profile_probe VALUES (1)");
    try {
      probe.exec("INSERT INTO profile_probe VALUES (1)");
      fail("UNSUPPORTED_STORE_PROFILE", "node:sqlite numeric error contract probe did not fail");
    } catch (cause) {
      if (cause instanceof Error && "attuneGraphCode" in cause) throw cause;
      if (sqlitePrimaryCode(cause) === undefined) {
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
    const physicalIdentity = initializeSchema(pathProfile.wasEmpty);
    const journalMode = sqlRow(
      getSql(database.prepare("PRAGMA journal_mode = WAL")),
      "journal mode row",
      ["journal_mode"]
    ).journal_mode;
    if (journalMode !== "wal") {
      fail("UNSUPPORTED_STORE_PROFILE", "SQLite WAL mode could not be established");
    }
    execSql("PRAGMA synchronous = FULL");
    assertSidecars(pathProfile.databasePath);
    if (
      sqlRow(getSql(database.prepare("PRAGMA foreign_keys")), "foreign keys row", ["foreign_keys"]).foreign_keys !== 1n
      || sqlRow(getSql(database.prepare("PRAGMA trusted_schema")), "trusted schema row", ["trusted_schema"]).trusted_schema !== 0n
      || sqlRow(getSql(database.prepare("PRAGMA synchronous")), "synchronous row", ["synchronous"]).synchronous !== 2n
    ) {
      fail("UNSUPPORTED_STORE_PROFILE", "SQLite safety pragmas could not be established");
    }
    assertDatabaseIntegrity(physicalIdentity);
    statements = prepareStatements();
    initialized = true;
    return {
      applicationId: APPLICATION_ID,
      profileVersion: 1,
      protocolVersion: PROTOCOL_VERSION,
      sqliteVersion: /** @type {string} */ (process.versions.sqlite),
      userVersion: USER_VERSION
    };
  } catch (cause) {
    try {
      database?.close();
    } catch {
      // The initialization failure remains authoritative.
    }
    if (cause instanceof Error && "attuneGraphCode" in cause) throw cause;
    mapSqliteFailure(cause, "SQLite initialization");
  }
}

function assertReady() {
  if (!initialized || !database || !statements || closing) {
    fail("STORE_FAILURE", "worker store is not open");
  }
}

/** @param {Record<string, unknown>} row @param {import("./attunegraph-contracts.js").AttuneGraphScope} scope */
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
  /** @type {unknown} */
  let parsed;
  try {
    parsed = /** @type {unknown} */ (JSON.parse(row.projectionJson));
  } catch (cause) {
    fail("CORRUPT_STORE", "journal projection payload is malformed JSON", cause);
  }
  let projection;
  try {
    projection = parseProjection(parsed, scope);
  } catch (cause) {
    fail("CORRUPT_STORE", "journal projection payload is structurally invalid", cause);
  }
  if (JSON.stringify(projection) !== row.projectionJson) {
    fail("CORRUPT_STORE", "journal projection payload is not canonical JSON");
  }
  if (
    projection.snapshot.generation !== generation
    || projection.snapshot.commitId !== commitId
    || projection.projectionFingerprint !== fingerprint
  ) {
    fail("CORRUPT_STORE", "journal payload does not match its physical identity");
  }
  return projection;
}

/** @param {import("./attunegraph-local-protocol.mjs").ReadPayload} payload @returns {import("./attunegraph-local-protocol.mjs").ReadResult} */
function read(payload) {
  assertReady();
  if (testFault === "hang-read") {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
  }
  const input = plainRecord(payload, "read payload", ["scope"]);
  const scope = parseScope(input.scope);
  const rows = sqlRows(
    allSql(statements.read, scope.sourceId, scope.threadId),
    "journal read rows",
    ["generation", "commitId", "projectionJson", "projectionFingerprint"],
    "CORRUPT_STORE"
  );
  if (rows.length > 1) fail("CORRUPT_STORE", "scope has more than one head");
  if (rows.length === 0) {
    if (currentSnapshot(scope) !== undefined) {
      fail("CORRUPT_STORE", "scope head does not identify an exact journal row");
    }
    return { found: false };
  }
  const row = rows[0];
  if (!row) fail("CORRUPT_STORE", "scope head row is missing");
  return { found: true, projection: decodeStoredProjection(row, scope) };
}

/** @param {import("./attunegraph-contracts.js").AttuneGraphScope} scope @returns {import("./attunegraph-contracts.js").AttuneGraphSnapshot | undefined} */
function currentSnapshot(scope) {
  const rows = sqlRows(
    allSql(statements.current, scope.sourceId, scope.threadId),
    "head read rows",
    ["generation", "commitId"],
    "CORRUPT_STORE"
  );
  if (rows.length > 1) fail("CORRUPT_STORE", "scope has more than one head");
  if (rows.length === 0) return undefined;
  const row = rows[0];
  if (!row) fail("CORRUPT_STORE", "scope head row is missing");
  return {
    schemaVersion: 1,
    scope,
    generation: safeInteger(row.generation, "head generation", 1n),
    commitId: boundedText(row.commitId, "head commit", MAX_TEXT, "CORRUPT_STORE")
  };
}

/** @param {import("./attunegraph-contracts.js").AttuneGraphSnapshot | undefined} left @param {import("./attunegraph-contracts.js").AttuneGraphSnapshot | undefined} right */
function sameSnapshot(left, right) {
  return (
    left?.schemaVersion === right?.schemaVersion
    && left?.generation === right?.generation
    && left?.commitId === right?.commitId
    && left?.scope.sourceId === right?.scope.sourceId
    && left?.scope.threadId === right?.scope.threadId
  );
}

/** @param {import("./attunegraph-local-protocol.mjs").CompareAndSwapPayload} payload @returns {import("./attunegraph-local-protocol.mjs").CompareAndSwapResult} */
function compareAndSwap(payload) {
  assertReady();
  const input = plainRecord(payload, "compare-and-swap payload", [
    "scope",
    "expected",
    "proposed"
  ]);
  const scope = parseScope(input.scope);
  const expected = input.expected === null
    ? undefined
    : parseSnapshot(input.expected, scope, "expected snapshot");
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

/** @param {import("./attunegraph-local-protocol.mjs").EmptyPayload} payload @returns {import("./attunegraph-local-protocol.mjs").CloseResult} */
function closeStore(payload) {
  plainRecord(payload, "close payload", []);
  if (testFault === "hang-close") {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
  }
  if (closing) return { closed: true };
  closing = true;
  if (database) {
    try {
      const row = sqlRow(
        /** @type {unknown} */ (database.prepare("PRAGMA wal_checkpoint(PASSIVE)").get()),
        "checkpoint row",
        ["busy", "log", "checkpointed"]
      );
      safeInteger(row.busy, "checkpoint busy", 0n, "STORE_FAILURE");
      safeInteger(row.log, "checkpoint log", -1n, "STORE_FAILURE");
      safeInteger(row.checkpointed, "checkpoint completed", -1n, "STORE_FAILURE");
    } catch (cause) {
      if (cause instanceof Error && "attuneGraphCode" in cause) throw cause;
      mapSqliteFailure(cause, "PASSIVE checkpoint");
    } finally {
      try {
        database.close();
      } catch (cause) {
        mapSqliteFailure(cause, "SQLite close");
      }
      initialized = false;
    }
  }
  return { closed: true };
}

/** @param {import("./attunegraph-local-protocol.mjs").HoldWriteLockPayload} payload @returns {import("./attunegraph-local-protocol.mjs").HoldWriteLockResult} */
function holdWriteLockForTesting(payload) {
  assertReady();
  if (!testFixtureMode) fail("STORE_FAILURE", "worker test fixture mode is disabled");
  const input = payload;
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

/** @param {import("./attunegraph-local-protocol.mjs").EmptyPayload} payload @returns {import("./attunegraph-local-protocol.mjs").InspectResult} */
function inspectForTesting(payload) {
  assertReady();
  if (!testFixtureMode) fail("STORE_FAILURE", "worker test fixture mode is disabled");
  plainRecord(payload, "inspection payload", []);
  const row = sqlRow(getSql(database.prepare(`
    SELECT
      (SELECT COUNT(*) FROM attunegraph_projection_head) AS headRows,
      (SELECT COUNT(*) FROM attunegraph_projection_journal) AS journalRows,
      COALESCE((SELECT MAX(generation) FROM attunegraph_projection_journal), 0) AS maxGeneration
  `)), "inspection row", ["headRows", "journalRows", "maxGeneration"]);
  return {
    headRows: safeInteger(row.headRows, "inspection head count", 0n),
    journalRows: safeInteger(row.journalRows, "inspection journal count", 0n),
    maxGeneration: safeInteger(row.maxGeneration, "inspection max generation", 0n)
  };
}

/** @param {import("./attunegraph-local-protocol.mjs").MutatePayload} payload @returns {import("./attunegraph-local-protocol.mjs").MutateResult} */
function mutateForTesting(payload) {
  assertReady();
  if (!testFixtureMode) fail("STORE_FAILURE", "worker test fixture mode is disabled");
  const input = payload;
  switch (input.mutation) {
    case "future-user-version":
      execSql("PRAGMA user_version = 2", "future-version test mutation");
      break;
    case "wrong-application-id":
      execSql("PRAGMA application_id = 1", "application-id test mutation");
      break;
    case "malformed-projection-json":
      runSql(database.prepare(
        "UPDATE attunegraph_projection_journal SET projection_json = '{' "
          + "WHERE (source_id, thread_id, generation) IN "
          + "(SELECT source_id, thread_id, generation FROM attunegraph_projection_head)"
      ));
      break;
    case "missing-journal-row":
      execSql("PRAGMA foreign_keys = OFF", "disable foreign keys for test mutation");
      runSql(database.prepare(
        "DELETE FROM attunegraph_projection_journal "
          + "WHERE (source_id, thread_id, generation) IN "
          + "(SELECT source_id, thread_id, generation FROM attunegraph_projection_head)"
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
            "UPDATE attunegraph_projection_journal SET projection_json = ? "
              + "WHERE (source_id, thread_id, generation) IN "
              + "(SELECT source_id, thread_id, generation FROM attunegraph_projection_head)"
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
        "UPDATE attunegraph_projection_head SET commit_id = 'mismatched-head'"
      ));
      execSql("PRAGMA foreign_keys = ON", "restore foreign keys after mismatched-head test");
      break;
    case "quick-check-corruption":
      database.enableDefensive(false);
      try {
        execSql("PRAGMA writable_schema = ON", "enable writable schema for corruption test");
        runSql(database.prepare(
          "UPDATE sqlite_schema SET rootpage = 2147483647 "
            + "WHERE name = 'attunegraph_projection_journal'"
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

/** @param {import("./attunegraph-local-protocol.mjs").WorkerRequest} request @returns {Promise<import("./attunegraph-local-protocol.mjs").WorkerResult>} */
export async function dispatchSqliteRequest(request) {
  if (isMainThread) {
    fail("STORE_FAILURE", "SQLite execution is available only in a Worker");
  }
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
