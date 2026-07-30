import { Buffer } from "node:buffer";
import {
  DatabaseSync,
  StatementSync,
  type SQLInputValue
} from "node:sqlite";
import {
  TextDecoder,
  TextEncoder,
  types as nodeTypes
} from "node:util";

import type {
  AttuneGraphPortableDecoderValidationSink
} from "./attunegraph-portable-decoder.js";
import type {
  AttuneGraphPortableHeadIdentity,
  AttuneGraphPortableProjectionIdentity
} from "./attunegraph-portable-encoder.js";

const APPLICATION_ID = 0x4d505631;
const USER_VERSION = 1;
const BUSY_TIMEOUT_MS = 1_000;
const STORE_ID = /^attunegraph-store:[0-9a-f]{64}$/u;
const MAX_TEXT = 512;

const CREATE_SCOPE = `CREATE TABLE main.attunegraph_portable_validation_scope (
  source_id BLOB NOT NULL,
  thread_id BLOB NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  commit_id TEXT NOT NULL CHECK (length(commit_id) BETWEEN 1 AND ${MAX_TEXT}),
  projection_id TEXT NOT NULL CHECK (length(projection_id) = 82),
  head_seen INTEGER NOT NULL DEFAULT 0 CHECK (head_seen IN (0, 1)),
  PRIMARY KEY (source_id, thread_id)
) STRICT, WITHOUT ROWID`;
const CREATE_HEAD_INDEX = `CREATE INDEX main.attunegraph_portable_validation_head_seen
ON attunegraph_portable_validation_scope (head_seen)`;

const databasePrototype = DatabaseSync.prototype;
const statementPrototype = StatementSync.prototype;
const databaseExec = databasePrototype.exec;
const databasePrepare = databasePrototype.prepare;
const databaseClose = databasePrototype.close;
const statementGet = statementPrototype.get;
const statementRun = statementPrototype.run;
const statementAll = statementPrototype.all;
const reflectApply = Reflect.apply;
const reflectGetPrototypeOf = Reflect.getPrototypeOf;
const reflectOwnKeys = Reflect.ownKeys;
const objectGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const objectFreeze = Object.freeze;
const textEncoder = new TextEncoder();
const fatalTextDecoder = new TextDecoder("utf8", { fatal: true });

const databaseAccessors = (() => {
  const unopened = new DatabaseSync(":memory:", { open: false });
  return objectFreeze({
    isOpen: objectGetOwnPropertyDescriptor(unopened, "isOpen")!.get!,
    isTransaction: objectGetOwnPropertyDescriptor(
      unopened,
      "isTransaction"
    )!.get!
  });
})();
const isOpenGetter = databaseAccessors.isOpen;
const isTransactionGetter = databaseAccessors.isTransaction;

export type AttuneGraphPortableIndexedValidationSinkErrorCode =
  | "INVALID_INPUT"
  | "INVALID_STATE"
  | "REENTRY"
  | "HEAD_MISMATCH"
  | "STORE_FAILURE";

export class AttuneGraphPortableIndexedValidationSinkError extends Error {
  readonly code: AttuneGraphPortableIndexedValidationSinkErrorCode;

  constructor(
    code: AttuneGraphPortableIndexedValidationSinkErrorCode,
    message: string
  ) {
    super(message);
    this.name = "AttuneGraphPortableIndexedValidationSinkError";
    this.code = code;
  }
}

type SqliteOperation =
  | "begin"
  | "execute"
  | "commit"
  | "rollback"
  | "quick-check"
  | "close";

export interface AttuneGraphPortableIndexedValidationFaultForInternalUse {
  readonly operation: SqliteOperation;
  readonly occurrence?: number;
  readonly payload: unknown;
  readonly runtimeOnly?: true;
  readonly beforeOperation?: (operation: SqliteOperation) => void;
}

export type AttuneGraphPortableIndexedTerminalCloseOutcomeForInternalUse =
  | "closed"
  | "unknown";

export interface AttuneGraphPortableIndexedValidationCreationForInternalUse {
  readonly sink: AttuneGraphPortableDecoderValidationSink;
  terminalCloseOutcome(): AttuneGraphPortableIndexedTerminalCloseOutcomeForInternalUse;
}

interface Statements {
  readonly current: StatementSync;
  readonly insertScope: StatementSync;
  readonly updateScope: StatementSync;
  readonly assertHead: StatementSync;
  readonly counts: StatementSync;
}

type Phase = "projections" | "heads" | "finished" | "aborted";
type DataRecord = Record<string, unknown>;
type DetachedIdentity = AttuneGraphPortableProjectionIdentity & {
  readonly sourceBytes: Buffer;
  readonly threadBytes: Buffer;
};

function sinkError(
  code: AttuneGraphPortableIndexedValidationSinkErrorCode,
  message: string
): AttuneGraphPortableIndexedValidationSinkError {
  return new AttuneGraphPortableIndexedValidationSinkError(code, message);
}

function dataRecord(
  value: unknown,
  label: string,
  keys: readonly string[]
): DataRecord {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || nodeTypes.isProxy(value)
    || (
      reflectGetPrototypeOf(value) !== Object.prototype
      && reflectGetPrototypeOf(value) !== null
    )
    || reflectOwnKeys(value).length !== keys.length
  ) {
    throw sinkError("INVALID_INPUT", `${label} must be an exact data record`);
  }
  const output = Object.create(null) as DataRecord;
  for (const key of keys) {
    const descriptor = objectGetOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || descriptor.enumerable !== true
    ) {
      throw sinkError("INVALID_INPUT", `${label} must be an exact data record`);
    }
    output[key] = descriptor.value;
  }
  if (
    reflectOwnKeys(value).some((key) =>
      typeof key !== "string" || !keys.includes(key)
    )
  ) {
    throw sinkError("INVALID_INPUT", `${label} must be an exact data record`);
  }
  return output;
}

function boundedText(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > MAX_TEXT
    || value !== value.trim()
  ) {
    throw sinkError("INVALID_INPUT", `${label} must be bounded text`);
  }
  return value;
}

function scopeText(value: unknown, label: string): {
  readonly text: string;
  readonly bytes: Buffer;
} {
  const text = boundedText(value, label);
  const bytes = Buffer.from(textEncoder.encode(text));
  let decoded: string;
  try {
    decoded = fatalTextDecoder.decode(bytes);
  } catch {
    throw sinkError("INVALID_INPUT", `${label} must be exact UTF-8`);
  }
  if (decoded !== text) {
    throw sinkError("INVALID_INPUT", `${label} must not contain unpaired surrogates`);
  }
  return objectFreeze({ text, bytes });
}

function detachedIdentity(
  value: unknown,
  label: string
): DetachedIdentity {
  const identity = dataRecord(
    value,
    label,
    ["scope", "generation", "commitId", "projectionId"]
  );
  const scope = dataRecord(
    identity.scope,
    `${label}.scope`,
    ["sourceId", "threadId"]
  );
  const source = scopeText(scope.sourceId, `${label}.scope.sourceId`);
  const thread = scopeText(scope.threadId, `${label}.scope.threadId`);
  if (
    !Number.isSafeInteger(identity.generation)
    || (identity.generation as number) < 1
  ) {
    throw sinkError("INVALID_INPUT", `${label}.generation must be positive`);
  }
  const commitId = boundedText(identity.commitId, `${label}.commitId`);
  if (
    typeof identity.projectionId !== "string"
    || !STORE_ID.test(identity.projectionId)
  ) {
    throw sinkError("INVALID_INPUT", `${label}.projectionId is invalid`);
  }
  return objectFreeze({
    scope: objectFreeze({
      sourceId: source.text,
      threadId: thread.text
    }),
    generation: identity.generation as number,
    commitId,
    projectionId: identity.projectionId as `attunegraph-store:${string}`,
    sourceBytes: source.bytes,
    threadBytes: thread.bytes
  });
}

function sqliteInteger(value: unknown, label: string): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(number) || (number as number) < 0) {
    throw sinkError("STORE_FAILURE", `${label} is invalid`);
  }
  return number as number;
}

function sqlRow(
  value: unknown,
  label: string,
  keys: readonly string[]
): DataRecord {
  try {
    return dataRecord(value, label, keys);
  } catch {
    throw sinkError("STORE_FAILURE", `${label} is invalid`);
  }
}

function normalizeSql(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
}

function validateFault(
  value: unknown
): AttuneGraphPortableIndexedValidationFaultForInternalUse {
  const allowed = [
    "operation",
    "occurrence",
    "payload",
    "runtimeOnly",
    "beforeOperation"
  ] as const;
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || nodeTypes.isProxy(value)
    || (
      reflectGetPrototypeOf(value) !== Object.prototype
      && reflectGetPrototypeOf(value) !== null
    )
  ) {
    throw sinkError("INVALID_INPUT", "indexed validation qualification fault is invalid");
  }
  const keys = reflectOwnKeys(value);
  if (
    !keys.includes("operation")
    || !keys.includes("payload")
    || keys.some((key) =>
      typeof key !== "string"
      || !allowed.includes(key as (typeof allowed)[number])
    )
  ) {
    throw sinkError("INVALID_INPUT", "indexed validation qualification fault is invalid");
  }
  const input = Object.create(null) as DataRecord;
  for (const key of keys) {
    const descriptor = objectGetOwnPropertyDescriptor(value, key);
    if (
      typeof key !== "string"
      || descriptor === undefined
      || !("value" in descriptor)
      || descriptor.enumerable !== true
    ) {
      throw sinkError("INVALID_INPUT", "indexed validation qualification fault is invalid");
    }
    input[key] = descriptor.value;
  }
  const operations: readonly SqliteOperation[] = [
    "begin",
    "execute",
    "commit",
    "rollback",
    "quick-check",
    "close"
  ];
  if (
    typeof input.operation !== "string"
    || !operations.includes(input.operation as SqliteOperation)
    || (
      input.occurrence !== undefined
      && (
        !Number.isSafeInteger(input.occurrence)
        || (input.occurrence as number) < 1
      )
    )
    || (
      input.runtimeOnly !== undefined
      && input.runtimeOnly !== true
    )
    || (
      input.beforeOperation !== undefined
      && typeof input.beforeOperation !== "function"
    )
  ) {
    throw sinkError("INVALID_INPUT", "indexed validation qualification fault is invalid");
  }
  return objectFreeze({
    operation: input.operation as SqliteOperation,
    occurrence: input.occurrence as number | undefined,
    payload: input.payload,
    runtimeOnly: input.runtimeOnly as true | undefined,
    beforeOperation: input.beforeOperation as
      | ((operation: SqliteOperation) => void)
      | undefined
  });
}

function createIndexedSink(
  candidate: unknown,
  qualificationFaultInput: unknown,
  qualificationMode: boolean
): AttuneGraphPortableIndexedValidationCreationForInternalUse {
  if (
    candidate === null
    || typeof candidate !== "object"
    || nodeTypes.isProxy(candidate)
    || reflectGetPrototypeOf(candidate) !== databasePrototype
  ) {
    throw sinkError("INVALID_INPUT", "indexed validation database must be genuine");
  }
  const openDescriptor = objectGetOwnPropertyDescriptor(candidate, "isOpen");
  const transactionDescriptor = objectGetOwnPropertyDescriptor(
    candidate,
    "isTransaction"
  );
  if (
    openDescriptor?.get !== isOpenGetter
    || transactionDescriptor?.get !== isTransactionGetter
  ) {
    throw sinkError("INVALID_INPUT", "indexed validation database must be genuine");
  }

  const database = candidate as DatabaseSync;
  try {
    reflectApply(isOpenGetter, database, []);
    reflectApply(isTransactionGetter, database, []);
  } catch {
    throw sinkError("INVALID_INPUT", "indexed validation database must be genuine");
  }

  let phase: Phase = "projections";
  let operationActive = false;
  let terminalPinned = false;
  let terminalFailure: unknown;
  let transactionStarted = false;
  let committed = false;
  let rollbackAttempted = false;
  let closeAttempted = false;
  let closeOutcome:
    | "unobserved"
    | AttuneGraphPortableIndexedTerminalCloseOutcomeForInternalUse = "unobserved";
  let statements: Statements | undefined;
  let currentIdentity: DetachedIdentity | undefined;
  let initialized = false;
  let qualificationFault:
    | AttuneGraphPortableIndexedValidationFaultForInternalUse
    | undefined;
  let projectionCount = 0;
  let headCount = 0;
  let scopeCount = 0;
  const faultCounts: Record<SqliteOperation, number> = {
    begin: 0,
    execute: 0,
    commit: 0,
    rollback: 0,
    "quick-check": 0,
    close: 0
  };

  const maybeFault = (
    operation: SqliteOperation,
    terminalCleanup = false
  ): void => {
    if (qualificationFault?.runtimeOnly === true && !initialized) return;
    qualificationFault?.beforeOperation?.(operation);
    if (terminalPinned && !terminalCleanup) throw terminalFailure;
    faultCounts[operation] += 1;
    if (
      qualificationFault?.operation === operation
      && faultCounts[operation] === (qualificationFault.occurrence ?? 1)
    ) {
      throw qualificationFault.payload;
    }
  };

  const exec = (
    sql: string,
    operation: SqliteOperation = "execute",
    terminalCleanup = false
  ): void => {
    maybeFault(operation, terminalCleanup);
    try {
      reflectApply(databaseExec, database, [sql]);
    } catch {
      throw sinkError("STORE_FAILURE", "indexed validation SQLite operation failed");
    }
  };

  const prepare = (sql: string): StatementSync => {
    maybeFault("execute");
    try {
      return reflectApply(databasePrepare, database, [sql]) as StatementSync;
    } catch {
      throw sinkError("STORE_FAILURE", "indexed validation SQLite operation failed");
    }
  };

  const get = (
    statement: StatementSync,
    parameters: readonly SQLInputValue[] = []
  ): unknown => {
    maybeFault("execute");
    try {
      return reflectApply(statementGet, statement, parameters);
    } catch {
      throw sinkError("STORE_FAILURE", "indexed validation SQLite operation failed");
    }
  };

  const run = (
    statement: StatementSync,
    parameters: readonly SQLInputValue[]
  ): number => {
    maybeFault("execute");
    try {
      const result = sqlRow(
        reflectApply(statementRun, statement, parameters),
        "indexed validation SQLite write result",
        ["changes", "lastInsertRowid"]
      );
      return sqliteInteger(result.changes, "indexed validation SQLite changes");
    } catch (cause) {
      if (cause instanceof AttuneGraphPortableIndexedValidationSinkError) throw cause;
      throw sinkError("STORE_FAILURE", "indexed validation SQLite operation failed");
    }
  };

  const isTransaction = (): boolean => {
    try {
      return reflectApply(isTransactionGetter, database, []) as boolean;
    } catch {
      throw sinkError("STORE_FAILURE", "indexed validation transaction state failed");
    }
  };

  const rollback = (): void => {
    if (
      rollbackAttempted
      || committed
      || !transactionStarted
    ) return;
    rollbackAttempted = true;
    try {
      if (isTransaction()) exec("ROLLBACK", "rollback", true);
    } catch {
      // The original failure remains authoritative.
    }
  };

  const close = (): void => {
    if (closeAttempted) return;
    closeAttempted = true;
    try {
      maybeFault("close", true);
    } catch (cause) {
      closeOutcome = "unknown";
      throw cause;
    }
    try {
      // StatementSync has no finalize API; DatabaseSync.close finalizes its
      // fixed prepared statements as part of the transferred handle close.
      reflectApply(databaseClose, database, []);
    } catch {
      closeOutcome = "unknown";
      throw sinkError("STORE_FAILURE", "indexed validation database close failed");
    }
    closeOutcome = "closed";
  };

  const cleanup = (): void => {
    rollback();
    try {
      close();
    } catch {
      // The original failure remains authoritative.
    }
  };

  const pinFailure = (cause: unknown): never => {
    if (!terminalPinned) {
      terminalPinned = true;
      terminalFailure = cause;
      phase = "aborted";
    }
    cleanup();
    throw terminalFailure;
  };

  const assertProfile = (): void => {
    const application = sqlRow(
      get(prepare("PRAGMA main.application_id")),
      "indexed validation application profile",
      ["application_id"]
    );
    const version = sqlRow(
      get(prepare("PRAGMA main.user_version")),
      "indexed validation version profile",
      ["user_version"]
    );
    const busy = sqlRow(
      get(prepare("PRAGMA main.busy_timeout")),
      "indexed validation busy profile",
      ["timeout"]
    );
    if (
      sqliteInteger(application.application_id, "application id") !== APPLICATION_ID
      || sqliteInteger(version.user_version, "user version") !== USER_VERSION
      || sqliteInteger(busy.timeout, "busy timeout") !== BUSY_TIMEOUT_MS
    ) {
      throw sinkError("STORE_FAILURE", "indexed validation SQLite profile mismatch");
    }
    const schemaRows = reflectApply(
      statementAll,
      prepare(
        "SELECT type, name, sql FROM main.sqlite_schema "
        + "WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
      ),
      []
    ) as unknown;
    if (
      !Array.isArray(schemaRows)
      || schemaRows.length !== 2
      || nodeTypes.isProxy(schemaRows)
    ) {
      throw sinkError("STORE_FAILURE", "indexed validation SQLite schema mismatch");
    }
    const expected = [
      [
        "index",
        "attunegraph_portable_validation_head_seen",
        CREATE_HEAD_INDEX.replace("main.", "")
      ],
      [
        "table",
        "attunegraph_portable_validation_scope",
        CREATE_SCOPE.replace("main.", "")
      ]
    ] as const;
    for (let index = 0; index < expected.length; index += 1) {
      const row = sqlRow(
        schemaRows[index],
        "indexed validation schema row",
        ["type", "name", "sql"]
      );
      if (
        row.type !== expected[index]![0]
        || row.name !== expected[index]![1]
        || normalizeSql(row.sql) !== normalizeSql(expected[index]![2])
      ) {
        throw sinkError("STORE_FAILURE", "indexed validation SQLite schema mismatch");
      }
    }
  };

  const assertConnectionProfile = (
    code: "INVALID_INPUT" | "STORE_FAILURE"
  ): void => {
    const databases = reflectApply(
      statementAll,
      prepare("PRAGMA main.database_list"),
      []
    ) as unknown;
    if (
      !Array.isArray(databases)
      || nodeTypes.isProxy(databases)
      || databases.length !== 1
    ) {
      throw sinkError(code, "indexed validation database attachment profile mismatch");
    }
    const main = sqlRow(
      databases[0],
      "indexed validation database-list row",
      ["seq", "name", "file"]
    );
    if (
      sqliteInteger(main.seq, "indexed validation database sequence") !== 0
      || main.name !== "main"
      || typeof main.file !== "string"
    ) {
      throw sinkError(code, "indexed validation database attachment profile mismatch");
    }
    const temporary = sqlRow(
      get(prepare(
        "SELECT COUNT(*) AS count FROM main.pragma_table_list "
        + "WHERE schema = 'temp' AND name NOT LIKE 'sqlite_%'"
      )),
      "indexed validation temporary schema count",
      ["count"]
    );
    if (sqliteInteger(temporary.count, "temporary schema count") !== 0) {
      throw sinkError(code, "indexed validation temporary schema must be empty");
    }
  };

  const quickCheck = (): void => {
    maybeFault("quick-check");
    const row = sqlRow(
      get(prepare("PRAGMA main.quick_check")),
      "indexed validation quick-check",
      ["quick_check"]
    );
    if (row.quick_check !== "ok") {
      throw sinkError("STORE_FAILURE", "indexed validation quick-check failed");
    }
  };

  const initialize = (): void => {
    if (!reflectApply(isOpenGetter, database, [])) {
      throw sinkError("INVALID_INPUT", "indexed validation database is closed");
    }
    if (isTransaction()) {
      transactionStarted = true;
      throw sinkError("INVALID_INPUT", "indexed validation database has an active transaction");
    }
    assertConnectionProfile("INVALID_INPUT");
    const count = sqlRow(
      get(prepare(
        "SELECT COUNT(*) AS count FROM main.sqlite_schema "
        + "WHERE name NOT LIKE 'sqlite_%'"
      )),
      "indexed validation initial schema count",
      ["count"]
    );
    const application = sqlRow(
      get(prepare("PRAGMA main.application_id")),
      "indexed validation initial application profile",
      ["application_id"]
    );
    const version = sqlRow(
      get(prepare("PRAGMA main.user_version")),
      "indexed validation initial version profile",
      ["user_version"]
    );
    if (
      sqliteInteger(count.count, "initial schema count") !== 0
      || sqliteInteger(application.application_id, "initial application id") !== 0
      || sqliteInteger(version.user_version, "initial user version") !== 0
    ) {
      throw sinkError("INVALID_INPUT", "indexed validation database must be empty");
    }
    exec(`PRAGMA main.busy_timeout = ${BUSY_TIMEOUT_MS}`);
    exec("BEGIN IMMEDIATE", "begin");
    transactionStarted = true;
    exec(CREATE_SCOPE);
    exec(CREATE_HEAD_INDEX);
    exec(`PRAGMA main.application_id = ${APPLICATION_ID}`);
    exec(`PRAGMA main.user_version = ${USER_VERSION}`);
    quickCheck();
    assertProfile();
    statements = objectFreeze({
      current: prepare(`
        SELECT generation, commit_id AS commitId, projection_id AS projectionId
        FROM main.attunegraph_portable_validation_scope
        WHERE source_id = ? AND thread_id = ?
      `),
      insertScope: prepare(`
        INSERT INTO main.attunegraph_portable_validation_scope (
          source_id, thread_id, generation, commit_id, projection_id, head_seen
        ) VALUES (?, ?, ?, ?, ?, 0)
      `),
      updateScope: prepare(`
        UPDATE main.attunegraph_portable_validation_scope
        SET generation = ?, commit_id = ?, projection_id = ?
        WHERE source_id = ? AND thread_id = ?
          AND generation = ? AND commit_id = ? AND projection_id = ?
          AND head_seen = 0
      `),
      assertHead: prepare(`
        UPDATE main.attunegraph_portable_validation_scope SET head_seen = 1
        WHERE source_id = ? AND thread_id = ?
          AND generation = ? AND commit_id = ? AND projection_id = ?
          AND head_seen = 0
      `),
      counts: prepare(`
        SELECT COUNT(*) AS scopeCount,
          COALESCE(SUM(head_seen), 0) AS headCount
        FROM main.attunegraph_portable_validation_scope
      `)
    });
  };

  try {
    if (qualificationMode) {
      qualificationFault = validateFault(qualificationFaultInput);
    }
    initialize();
    initialized = true;
  } catch (cause) {
    if (!terminalPinned) {
      terminalPinned = true;
      terminalFailure = cause;
      phase = "aborted";
    }
    cleanup();
    throw terminalFailure;
  }

  const invoke = <Result>(operation: () => Result): Result => {
    if (terminalPinned) throw terminalFailure;
    if (phase === "finished") {
      throw sinkError("INVALID_STATE", "indexed validation sink is finished");
    }
    if (operationActive) {
      return pinFailure(sinkError("REENTRY", "indexed validation sink reentry"));
    }
    operationActive = true;
    try {
      const result = operation();
      if (terminalPinned) throw terminalFailure;
      return result;
    } catch (cause) {
      return pinFailure(cause);
    } finally {
      currentIdentity = undefined;
      operationActive = false;
    }
  };

  const sink: AttuneGraphPortableDecoderValidationSink = {
    appendProjection(value) {
      invoke(() => {
        if (phase !== "projections") {
          throw sinkError("INVALID_STATE", "indexed validation projection phase is closed");
        }
        currentIdentity = detachedIdentity(value, "portable projection identity");
        const identity = currentIdentity;
        const current = get(statements!.current, [
          identity.sourceBytes,
          identity.threadBytes
        ]);
        if (current === undefined) {
          if (identity.generation !== 1) {
            throw sinkError("INVALID_INPUT", "new scope generation must be 1");
          }
          if (run(statements!.insertScope, [
            identity.sourceBytes,
            identity.threadBytes,
            identity.generation,
            identity.commitId,
            identity.projectionId
          ]) !== 1) {
            throw sinkError("STORE_FAILURE", "indexed validation insert failed");
          }
          scopeCount += 1;
        } else {
          const row = sqlRow(
            current,
            "indexed validation current identity",
            ["generation", "commitId", "projectionId"]
          );
          const priorGeneration = sqliteInteger(
            row.generation,
            "indexed validation prior generation"
          );
          if (identity.generation !== priorGeneration + 1) {
            throw sinkError("INVALID_INPUT", "scope generations must be contiguous");
          }
          if (run(statements!.updateScope, [
            identity.generation,
            identity.commitId,
            identity.projectionId,
            identity.sourceBytes,
            identity.threadBytes,
            priorGeneration,
            row.commitId as SQLInputValue,
            row.projectionId as SQLInputValue
          ]) !== 1) {
            throw sinkError("STORE_FAILURE", "indexed validation update failed");
          }
        }
        projectionCount += 1;
      });
    },

    sealProjections() {
      invoke(() => {
        if (phase !== "projections") {
          throw sinkError("INVALID_STATE", "indexed validation projections already sealed");
        }
        phase = "heads";
      });
    },

    assertHead(value: AttuneGraphPortableHeadIdentity) {
      invoke(() => {
        if (phase !== "heads") {
          throw sinkError("INVALID_STATE", "indexed validation heads require a sealed projection phase");
        }
        currentIdentity = detachedIdentity(value, "portable head identity");
        const identity = currentIdentity;
        if (run(statements!.assertHead, [
          identity.sourceBytes,
          identity.threadBytes,
          identity.generation,
          identity.commitId,
          identity.projectionId
        ]) !== 1) {
          throw sinkError("HEAD_MISMATCH", "portable head does not match one final scope identity");
        }
        headCount += 1;
      });
    },

    finish(expectedScopeCount, expectedHeadCount) {
      invoke(() => {
        if (phase !== "heads") {
          throw sinkError("INVALID_STATE", "indexed validation finish requires heads phase");
        }
        if (
          !Number.isSafeInteger(expectedScopeCount)
          || expectedScopeCount < 0
          || !Number.isSafeInteger(expectedHeadCount)
          || expectedHeadCount < 0
          || expectedHeadCount !== expectedScopeCount
        ) {
          throw sinkError("INVALID_INPUT", "indexed validation finish counts are invalid");
        }
        const counts = sqlRow(
          get(statements!.counts),
          "indexed validation final counts",
          ["scopeCount", "headCount"]
        );
        const storedScopes = sqliteInteger(counts.scopeCount, "stored scope count");
        const storedHeads = sqliteInteger(counts.headCount, "stored head count");
        if (
          expectedScopeCount !== scopeCount
          || expectedHeadCount !== headCount
          || storedScopes !== scopeCount
          || storedHeads !== headCount
          || projectionCount < scopeCount
        ) {
          throw sinkError("HEAD_MISMATCH", "indexed validation final counts do not match");
        }
        quickCheck();
        assertConnectionProfile("STORE_FAILURE");
        assertProfile();
        exec("COMMIT", "commit");
        committed = true;
        close();
        phase = "finished";
      });
    },

    abort(cause) {
      if (phase === "finished") return;
      if (terminalPinned) {
        cleanup();
        return;
      }
      terminalPinned = true;
      terminalFailure = cause;
      phase = "aborted";
      cleanup();
    }
  };
  return objectFreeze({
    sink: objectFreeze(sink),
    terminalCloseOutcome() {
      if (closeOutcome === "unobserved") {
        throw sinkError(
          "INVALID_STATE",
          "indexed validation terminal close is not observable"
        );
      }
      return closeOutcome;
    }
  });
}

export function createAttuneGraphPortableIndexedValidationSink(
  database: DatabaseSync
): AttuneGraphPortableDecoderValidationSink {
  return createIndexedSink(database, undefined, false).sink;
}

export function createAttuneGraphPortableIndexedValidationSinkForQualification(
  database: DatabaseSync,
  fault: AttuneGraphPortableIndexedValidationFaultForInternalUse
): AttuneGraphPortableDecoderValidationSink {
  if (process.env.NODE_ENV !== "test") {
    throw sinkError(
      "INVALID_INPUT",
      "indexed validation qualification faults require the test runtime"
    );
  }
  return createIndexedSink(database, fault, true).sink;
}

export function createAttuneGraphPortableIndexedValidationSinkWithTerminalCloseOutcomeForInternalUse(
  database: DatabaseSync
): AttuneGraphPortableIndexedValidationCreationForInternalUse {
  return createIndexedSink(database, undefined, false);
}

export function createAttuneGraphPortableIndexedValidationSinkWithTerminalCloseOutcomeForQualification(
  database: DatabaseSync,
  fault: AttuneGraphPortableIndexedValidationFaultForInternalUse
): AttuneGraphPortableIndexedValidationCreationForInternalUse {
  if (process.env.NODE_ENV !== "test") {
    throw sinkError(
      "INVALID_INPUT",
      "indexed validation qualification faults require the test runtime"
    );
  }
  return createIndexedSink(database, fault, true);
}
