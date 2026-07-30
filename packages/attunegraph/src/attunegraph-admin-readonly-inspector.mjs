import { Buffer } from "node:buffer";
import { types as nodeTypes } from "node:util";

import {
  ADMIN_PROTOCOL_VERSION,
  parseAdminWorkerResponse
} from "./attunegraph-admin-readonly-protocol.mjs";
import {
  ATTUNEGRAPH_PHYSICAL_SCHEMA_V1,
  classifyAttuneGraphPhysicalSchemaV1
} from "./attunegraph-physical-schema-v1.mjs";

const isProxy = nodeTypes.isProxy;
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;
const MAX_SCHEMA_SQL_BYTES = 4_096;
const MAX_METADATA_BYTES = 512;

/** @typedef {"FUTURE_STORE_STATE" | "CORRUPT_STORE" | "STORE_BUSY" | "WORKER_FAILURE"} InspectorFailureCode */
/** @typedef {Readonly<{applicationId: 0x41544731, userVersion: 1, protocolVersion: 1, sqliteVersion: string, headRows: number, journalRows: number, maxGeneration: number}>} AdminSummaryResult */
/** @typedef {Readonly<{found: false}> | Readonly<{found: true, head: Readonly<{scope: Readonly<{sourceId: string, threadId: string}>, generation: number, commitId: string, projectionFingerprint: string}>}>} AdminHeadResult */
/** @typedef {Readonly<{verified: true}>} AdminIntegrityResult */

const failureMessages = Object.freeze({
  FUTURE_STORE_STATE: "Admin store version is unsupported",
  CORRUPT_STORE: "Admin store is corrupt",
  STORE_BUSY: "Admin store is busy",
  WORKER_FAILURE: "Admin worker failed"
});
/** @type {WeakMap<object, InspectorFailureCode>} */
const failureBrands = new WeakMap();

class InspectorFailure extends Error {
  /** @param {InspectorFailureCode} code */
  constructor(code) {
    super(failureMessages[code]);
    this.name = "AttuneGraphAdminReadonlyInspectorFailure";
    Object.defineProperty(this, "stack", {
      configurable: false,
      enumerable: false,
      value: `${this.name}: ${this.message}`,
      writable: false
    });
    failureBrands.set(this, code);
    Object.freeze(this);
  }
}

/** @param {InspectorFailureCode} code @returns {never} */
function failInspector(code) {
  throw new InspectorFailure(code);
}

/** @param {unknown} value @returns {InspectorFailureCode | undefined} */
export function readAttuneGraphAdminReadonlyInspectorFailure(value) {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return undefined;
  }
  return failureBrands.get(value);
}

/** @param {unknown} cause */
function sqlitePrimaryCode(cause) {
  if (
    cause === null
    || typeof cause !== "object"
    || isProxy(cause)
  ) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(cause, "errcode");
  if (
    descriptor === undefined
    || !Object.hasOwn(descriptor, "value")
    || !Number.isInteger(descriptor.value)
  ) return undefined;
  return /** @type {number} */ (descriptor.value) & 0xff;
}

/** @param {unknown} cause @returns {never} */
function mapFailure(cause) {
  const branded = readAttuneGraphAdminReadonlyInspectorFailure(cause);
  if (branded !== undefined) throw cause;
  const primary = sqlitePrimaryCode(cause);
  if (primary === SQLITE_BUSY || primary === SQLITE_LOCKED) {
    failInspector("STORE_BUSY");
  }
  if (primary === SQLITE_CORRUPT || primary === SQLITE_NOTADB) {
    failInspector("CORRUPT_STORE");
  }
  failInspector("WORKER_FAILURE");
}

/** @template T @param {() => T} operation @returns {T} */
function guarded(operation) {
  try {
    return operation();
  } catch (cause) {
    return mapFailure(cause);
  }
}

/** @param {unknown} value @param {number} maximum @param {boolean} [allowEmpty] */
function boundedText(value, maximum, allowEmpty = false) {
  if (
    typeof value !== "string"
    || (!allowEmpty && value.length === 0)
    || Buffer.byteLength(value, "utf8") > maximum
  ) failInspector("CORRUPT_STORE");
  return value;
}

/** @param {unknown} value @param {number} minimum @returns {number} */
function boundedInteger(value, minimum) {
  /** @type {unknown} */
  let number;
  if (typeof value === "bigint") {
    if (value < BigInt(minimum) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      failInspector("CORRUPT_STORE");
    }
    number = Number(value);
  } else {
    number = value;
  }
  if (
    typeof number !== "number"
    || !Number.isSafeInteger(number)
    || number < minimum
  ) {
    failInspector("CORRUPT_STORE");
  }
  return number;
}

/**
 * @param {unknown} value
 * @param {readonly string[]} fields
 * @returns {Readonly<Record<string, unknown>>}
 */
function admitRecord(value, fields) {
  if (
    value === null
    || typeof value !== "object"
    || isProxy(value)
  ) failInspector("CORRUPT_STORE");
  if (Array.isArray(value)) failInspector("CORRUPT_STORE");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    failInspector("CORRUPT_STORE");
  }
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== fields.length
    || ownKeys.some((key) => typeof key !== "string" || !fields.includes(key))
    || fields.some((field) => !Object.hasOwn(value, field))
  ) failInspector("CORRUPT_STORE");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  /** @type {Record<string, unknown>} */
  const detached = Object.create(null);
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !Object.hasOwn(descriptor, "value")
    ) failInspector("CORRUPT_STORE");
    detached[field] = descriptor.value;
  }
  return Object.freeze(detached);
}

/**
 * @param {unknown} value
 * @param {number} maximum
 * @param {readonly string[]} fields
 * @returns {readonly Readonly<Record<string, unknown>>[]}
 */
function admitRows(value, maximum, fields) {
  if (value === null || typeof value !== "object" || isProxy(value)) {
    failInspector("CORRUPT_STORE");
  }
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    failInspector("CORRUPT_STORE");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  if (
    lengthDescriptor === undefined
    || !Object.hasOwn(lengthDescriptor, "value")
    || !Number.isSafeInteger(lengthDescriptor.value)
    || lengthDescriptor.value < 0
    || lengthDescriptor.value > maximum
  ) failInspector("CORRUPT_STORE");
  const length = lengthDescriptor.value;
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== length + 1
    || ownKeys[length] !== "length"
  ) failInspector("CORRUPT_STORE");
  /** @type {Readonly<Record<string, unknown>>[]} */
  const detached = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    if (ownKeys[index] !== key) failInspector("CORRUPT_STORE");
    const descriptor = descriptors[key];
    if (
      descriptor === undefined
      || !descriptor.enumerable
      || !Object.hasOwn(descriptor, "value")
    ) failInspector("CORRUPT_STORE");
    detached.push(admitRecord(descriptor.value, fields));
  }
  return Object.freeze(detached);
}

/** @param {unknown} database */
function databaseCapabilities(database) {
  if (database === null || typeof database !== "object" || isProxy(database)) {
    failInspector("WORKER_FAILURE");
  }
  const exec = Reflect.get(database, "exec");
  const prepare = Reflect.get(database, "prepare");
  if (typeof exec !== "function" || typeof prepare !== "function") {
    failInspector("WORKER_FAILURE");
  }
  return Object.freeze({
    exec: exec.bind(database),
    prepare: prepare.bind(database)
  });
}

/** @param {ReturnType<typeof databaseCapabilities>} database @param {string} sql */
function statement(database, sql) {
  const prepared = database.prepare(sql);
  if (prepared === null || typeof prepared !== "object" || isProxy(prepared)) {
    failInspector("WORKER_FAILURE");
  }
  const get = Reflect.get(prepared, "get");
  const all = Reflect.get(prepared, "all");
  if (typeof get !== "function" || typeof all !== "function") {
    failInspector("WORKER_FAILURE");
  }
  return Object.freeze({
    all: all.bind(prepared),
    get: get.bind(prepared)
  });
}

/**
 * @param {ReturnType<typeof databaseCapabilities>} database
 * @param {string} sql
 * @param {unknown[]} [parameters]
 */
function getRow(database, sql, parameters = []) {
  return statement(database, sql).get(...parameters);
}

/**
 * @param {ReturnType<typeof databaseCapabilities>} database
 * @param {string} sql
 * @param {unknown[]} [parameters]
 */
function getRows(database, sql, parameters = []) {
  return statement(database, sql).all(...parameters);
}

/** @param {ReturnType<typeof databaseCapabilities>} database */
function readPhysicalProfile(database) {
  const application = admitRecord(
    getRow(database, "PRAGMA application_id"),
    ["application_id"]
  );
  const version = admitRecord(
    getRow(database, "PRAGMA user_version"),
    ["user_version"]
  );
  const schemaRows = admitRows(getRows(database,
    "SELECT type, name, tbl_name AS tableName, sql FROM sqlite_schema "
      + "WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name LIMIT 4"
  ), 4, ["type", "name", "tableName", "sql"]);
  if (schemaRows.length === 4) failInspector("CORRUPT_STORE");
  const objects = Object.freeze(schemaRows.map((row) => Object.freeze({
    type: boundedText(row.type, MAX_METADATA_BYTES),
    name: boundedText(row.name, MAX_METADATA_BYTES),
    tableName: boundedText(row.tableName, MAX_METADATA_BYTES),
    normalizedSql: boundedText(row.sql, MAX_SCHEMA_SQL_BYTES)
      .replace(/\s+/g, " ")
      .trim()
  })));
  const foreignKeyRows = admitRows(getRows(database,
    `SELECT id, seq, "table" AS "table", "from" AS "from", "to" AS "to",
            on_update AS onUpdate, on_delete AS onDelete, match
     FROM pragma_foreign_key_list('attunegraph_projection_head')
     ORDER BY id, seq
     LIMIT 5`
  ), 5, [
    "id",
    "seq",
    "table",
    "from",
    "to",
    "onUpdate",
    "onDelete",
    "match"
  ]);
  if (foreignKeyRows.length === 5) failInspector("CORRUPT_STORE");
  const headForeignKey = Object.freeze(foreignKeyRows.map((row) => Object.freeze({
    id: boundedInteger(row.id, 0),
    seq: boundedInteger(row.seq, 0),
    table: boundedText(row.table, MAX_METADATA_BYTES),
    from: boundedText(row.from, MAX_METADATA_BYTES),
    to: boundedText(row.to, MAX_METADATA_BYTES),
    onUpdate: boundedText(row.onUpdate, MAX_METADATA_BYTES),
    onDelete: boundedText(row.onDelete, MAX_METADATA_BYTES),
    match: boundedText(row.match, MAX_METADATA_BYTES)
  })));
  return Object.freeze({
    applicationId: boundedInteger(application.application_id, 0),
    userVersion: boundedInteger(version.user_version, 0),
    objects,
    headForeignKey
  });
}

/** @param {"inspectSummary" | "inspectHead" | "verifyIntegrity"} type @param {unknown} result */
function admitResult(type, result) {
  const response = parseAdminWorkerResponse({
    protocolVersion: ADMIN_PROTOCOL_VERSION,
    id: 1,
    ok: true,
    result
  }, type);
  if (!response.ok) failInspector("WORKER_FAILURE");
  return response.result;
}

/** @param {unknown} value */
function admitScope(value) {
  const scope = admitRecord(value, ["sourceId", "threadId"]);
  return Object.freeze({
    sourceId: boundedText(scope.sourceId, MAX_METADATA_BYTES),
    threadId: boundedText(scope.threadId, MAX_METADATA_BYTES)
  });
}

/** @param {ReturnType<typeof databaseCapabilities>} database */
function assertMatchingPhysicalProfile(database) {
  const classification = classifyAttuneGraphPhysicalSchemaV1(readPhysicalProfile(database));
  if (classification.kind === "future") failInspector("FUTURE_STORE_STATE");
  if (classification.kind !== "match") failInspector("CORRUPT_STORE");
}

/** @param {unknown} database */
export function createAttuneGraphAdminReadOnlyInspector(database) {
  return guarded(() => {
    const capabilities = databaseCapabilities(database);
    capabilities.exec("PRAGMA query_only = ON");
    capabilities.exec("PRAGMA trusted_schema = OFF");
    capabilities.exec("PRAGMA foreign_keys = ON");
    const queryOnly = admitRecord(
      getRow(capabilities, "PRAGMA query_only"),
      ["query_only"]
    );
    const trustedSchema = admitRecord(
      getRow(capabilities, "PRAGMA trusted_schema"),
      ["trusted_schema"]
    );
    const foreignKeys = admitRecord(
      getRow(capabilities, "PRAGMA foreign_keys"),
      ["foreign_keys"]
    );
    if (
      boundedInteger(queryOnly.query_only, 0) !== 1
      || boundedInteger(trustedSchema.trusted_schema, 0) !== 0
      || boundedInteger(foreignKeys.foreign_keys, 0) !== 1
    ) failInspector("WORKER_FAILURE");
    assertMatchingPhysicalProfile(capabilities);
    const sqliteVersionRow = admitRecord(
      getRow(capabilities, "SELECT sqlite_version() AS sqliteVersion"),
      ["sqliteVersion"]
    );
    const sqliteVersion = boundedText(
      sqliteVersionRow.sqliteVersion,
      MAX_SCHEMA_SQL_BYTES,
      true
    );

    const inspectSummary = () => guarded(() => {
      const row = admitRecord(getRow(capabilities, `
        SELECT
          (SELECT COUNT(*) FROM attunegraph_projection_head) AS headRows,
          (SELECT COUNT(*) FROM attunegraph_projection_journal) AS journalRows,
          COALESCE((SELECT MAX(generation) FROM attunegraph_projection_journal), 0) AS maxGeneration
      `), ["headRows", "journalRows", "maxGeneration"]);
      return /** @type {AdminSummaryResult} */ (admitResult("inspectSummary", {
        applicationId: ATTUNEGRAPH_PHYSICAL_SCHEMA_V1.applicationId,
        userVersion: ATTUNEGRAPH_PHYSICAL_SCHEMA_V1.userVersion,
        protocolVersion: ADMIN_PROTOCOL_VERSION,
        sqliteVersion,
        headRows: boundedInteger(row.headRows, 0),
        journalRows: boundedInteger(row.journalRows, 0),
        maxGeneration: boundedInteger(row.maxGeneration, 0)
      }));
    });

    /** @param {unknown} value */
    const inspectHead = (value) => guarded(() => {
      const scope = admitScope(value);
      const rows = admitRows(getRows(capabilities, `
        SELECT h.source_id AS sourceId, h.thread_id AS threadId,
               h.generation AS generation, h.commit_id AS commitId,
               j.source_id AS journalPresence,
               j.projection_fingerprint AS projectionFingerprint
        FROM attunegraph_projection_head AS h
        LEFT JOIN attunegraph_projection_journal AS j
          ON j.source_id = h.source_id
         AND j.thread_id = h.thread_id
         AND j.generation = h.generation
         AND j.commit_id = h.commit_id
        WHERE h.source_id = ? AND h.thread_id = ?
        LIMIT 2
      `, [scope.sourceId, scope.threadId]), 2, [
        "sourceId",
        "threadId",
        "generation",
        "commitId",
        "journalPresence",
        "projectionFingerprint"
      ]);
      if (rows.length === 0) {
        return /** @type {AdminHeadResult} */ (
          admitResult("inspectHead", { found: false })
        );
      }
      if (rows.length !== 1) failInspector("CORRUPT_STORE");
      const row = rows[0];
      if (row === undefined) failInspector("CORRUPT_STORE");
      const sourceId = boundedText(row.sourceId, MAX_METADATA_BYTES);
      const threadId = boundedText(row.threadId, MAX_METADATA_BYTES);
      if (
        sourceId !== scope.sourceId
        || threadId !== scope.threadId
        || row.journalPresence !== scope.sourceId
      ) failInspector("CORRUPT_STORE");
      return /** @type {AdminHeadResult} */ (admitResult("inspectHead", {
        found: true,
        head: {
          scope: { sourceId, threadId },
          generation: boundedInteger(row.generation, 1),
          commitId: boundedText(row.commitId, MAX_METADATA_BYTES),
          projectionFingerprint: boundedText(
            row.projectionFingerprint,
            MAX_METADATA_BYTES
          )
        }
      }));
    });

    const verifyIntegrity = () => guarded(() => {
      capabilities.exec("BEGIN");
      try {
        const quick = admitRecord(
          getRow(capabilities, "PRAGMA quick_check(1)"),
          ["quick_check"]
        );
        if (quick.quick_check !== "ok") failInspector("CORRUPT_STORE");
        assertMatchingPhysicalProfile(capabilities);
        const foreignKeyViolation = getRow(capabilities,
          "SELECT * FROM pragma_foreign_key_check LIMIT 1"
        );
        if (foreignKeyViolation !== undefined) failInspector("CORRUPT_STORE");
        const orphan = admitRecord(getRow(capabilities, `
          SELECT EXISTS(
            SELECT 1
            FROM attunegraph_projection_head AS h
            LEFT JOIN attunegraph_projection_journal AS j
              ON j.source_id = h.source_id
             AND j.thread_id = h.thread_id
             AND j.generation = h.generation
             AND j.commit_id = h.commit_id
            WHERE j.source_id IS NULL
            LIMIT 1
          ) AS orphan
        `), ["orphan"]);
        if (boundedInteger(orphan.orphan, 0) !== 0) {
          failInspector("CORRUPT_STORE");
        }
        capabilities.exec("COMMIT");
        return /** @type {AdminIntegrityResult} */ (
          admitResult("verifyIntegrity", { verified: true })
        );
      } catch (cause) {
        try {
          capabilities.exec("ROLLBACK");
        } catch {
        }
        throw cause;
      }
    });

    return Object.freeze({
      inspectSummary,
      inspectHead,
      verifyIntegrity
    });
  });
}
