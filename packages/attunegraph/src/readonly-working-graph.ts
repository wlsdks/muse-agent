import { Buffer } from "node:buffer";
import { DatabaseSync } from "node:sqlite";
import { types as nodeTypes } from "node:util";

import { createAttuneGraphStore } from "./attunegraph-backend.js";
import type { AttuneGraphStoredProjection } from "./attunegraph-backend.js";
import type {
  AttuneGraphExecuteCommand,
  AttuneGraphOperatorResult,
  AttuneGraphScope
} from "./attunegraph-contracts.js";
import {
  createAttuneGraphAdminReadOnlyInspector,
  readAttuneGraphAdminReadonlyInspectorFailure
} from "./attunegraph-admin-readonly-inspector.mjs";
import {
  acquireAttuneGraphAdminReadonlySnapshot,
  readAttuneGraphAdminReadonlySnapshotFailure
} from "./attunegraph-admin-readonly-snapshot.mjs";
import {
  AttuneGraphAdminReadonlyError
} from "./attunegraph-admin-readonly-spine.js";
import { AttuneGraphError } from "./attunegraph-error.js";
import { openAttuneGraph } from "./attunegraph-engine.js";
import { ATTUNEGRAPH_PHYSICAL_SCHEMA_V1 } from "./attunegraph-physical-schema-v1.mjs";

export interface ReadLocalAttuneGraphWorkingGraphOptions {
  readonly command: AttuneGraphExecuteCommand;
  readonly databasePath: string;
  readonly scope: AttuneGraphScope;
}

interface SnapshotLease {
  readonly snapshotDatabasePath: string;
  release(): Promise<void>;
}

function readonlyError(cause: unknown): AttuneGraphAdminReadonlyError {
  if (cause instanceof AttuneGraphAdminReadonlyError) return cause;
  const snapshotCode = readAttuneGraphAdminReadonlySnapshotFailure(cause);
  if (snapshotCode !== undefined) {
    return new AttuneGraphAdminReadonlyError(snapshotCode);
  }
  const inspectorCode = readAttuneGraphAdminReadonlyInspectorFailure(cause);
  if (inspectorCode !== undefined) {
    return new AttuneGraphAdminReadonlyError(inspectorCode);
  }
  if (cause instanceof AttuneGraphError) {
    if (cause.code === "CORRUPT_STORE") {
      return new AttuneGraphAdminReadonlyError("CORRUPT_STORE");
    }
    if (cause.code === "FUTURE_STORE_STATE") {
      return new AttuneGraphAdminReadonlyError("FUTURE_STORE_STATE");
    }
  }
  return new AttuneGraphAdminReadonlyError("WORKER_FAILURE");
}

function exactOptions(
  value: unknown
): ReadLocalAttuneGraphWorkingGraphOptions {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || nodeTypes.isProxy(value)
  ) {
    throw new AttuneGraphAdminReadonlyError("UNSUPPORTED_PROFILE");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new AttuneGraphAdminReadonlyError("UNSUPPORTED_PROFILE");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const fields = ["command", "databasePath", "scope"] as const;
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.length !== fields.length
    || keys.some((key) =>
      typeof key !== "string"
      || !fields.includes(key as (typeof fields)[number])
      || descriptors[key] === undefined
      || !("value" in descriptors[key]!)
    )
    || fields.some((field) => !Object.hasOwn(descriptors, field))
  ) {
    throw new AttuneGraphAdminReadonlyError("UNSUPPORTED_PROFILE");
  }
  const databasePath = descriptors.databasePath!.value;
  if (typeof databasePath !== "string") {
    throw new AttuneGraphAdminReadonlyError("UNSUPPORTED_PROFILE");
  }
  return Object.freeze({
    command: descriptors.command!.value as AttuneGraphExecuteCommand,
    databasePath,
    scope: descriptors.scope!.value as AttuneGraphScope
  });
}

function projectionRow(value: unknown): AttuneGraphStoredProjection {
  if (
    value === undefined
    || value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || nodeTypes.isProxy(value)
  ) {
    throw new AttuneGraphAdminReadonlyError("CORRUPT_STORE");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  const descriptor = descriptors.projectionJson;
  if (
    keys.length !== 1
    || keys[0] !== "projectionJson"
    || descriptor === undefined
    || !Object.hasOwn(descriptor, "value")
    || typeof descriptor.value !== "string"
    || Buffer.byteLength(descriptor.value, "utf8")
      > ATTUNEGRAPH_PHYSICAL_SCHEMA_V1.maxProjectionBytes * 4
  ) {
    throw new AttuneGraphAdminReadonlyError("CORRUPT_STORE");
  }
  try {
    return JSON.parse(descriptor.value) as AttuneGraphStoredProjection;
  } catch {
    throw new AttuneGraphAdminReadonlyError("CORRUPT_STORE");
  }
}

async function releaseLease(
  lease: SnapshotLease,
  primary: AttuneGraphAdminReadonlyError | undefined
): Promise<AttuneGraphAdminReadonlyError | undefined> {
  try {
    await lease.release();
  } catch (cause) {
    return primary ?? readonlyError(cause);
  }
  return primary;
}

/**
 * Reads one Working Graph from a stable private snapshot of an existing closed
 * local store. SQLite never opens the source path, and this seam exposes no
 * projection, repair, bootstrap, or other write capability.
 */
export async function readLocalAttuneGraphWorkingGraph(
  options: ReadLocalAttuneGraphWorkingGraphOptions
): Promise<AttuneGraphOperatorResult> {
  const normalized = exactOptions(options);
  let lease: SnapshotLease;
  try {
    lease = await acquireAttuneGraphAdminReadonlySnapshot({
      databasePath: normalized.databasePath,
      sourceState: "closed-quiescent"
    });
  } catch (cause) {
    throw readonlyError(cause);
  }

  let database: DatabaseSync | undefined;
  let graph: Awaited<ReturnType<typeof openAttuneGraph>> | undefined;
  let result: AttuneGraphOperatorResult | undefined;
  let primary: AttuneGraphAdminReadonlyError | undefined;
  try {
    database = new DatabaseSync(lease.snapshotDatabasePath, {
      readOnly: true,
      allowExtension: false,
      defensive: true,
      enableDoubleQuotedStringLiterals: false,
      readBigInts: true,
      timeout: 250
    });
    database.enableLoadExtension(false);
    const inspector = createAttuneGraphAdminReadOnlyInspector(database);
    const head = inspector.inspectHead(normalized.scope);
    if (!head.found) {
      throw new AttuneGraphAdminReadonlyError("SOURCE_NOT_FOUND");
    }
    const statement = database.prepare(`
      SELECT j.projection_json AS projectionJson
      FROM attunegraph_projection_head AS h
      INNER JOIN attunegraph_projection_journal AS j
        ON j.source_id = h.source_id
       AND j.thread_id = h.thread_id
       AND j.generation = h.generation
       AND j.commit_id = h.commit_id
      WHERE h.source_id = ? AND h.thread_id = ?
      LIMIT 2
    `);
    const projection = projectionRow(statement.get(
      normalized.scope.sourceId,
      normalized.scope.threadId
    ));
    const store = createAttuneGraphStore({
      async read(scope) {
        return scope.sourceId === normalized.scope.sourceId
          && scope.threadId === normalized.scope.threadId
          ? projection
          : undefined;
      },
      async compareAndSwap() {
        throw new AttuneGraphAdminReadonlyError("INVALID_STATE");
      }
    });
    graph = await openAttuneGraph({
      scope: normalized.scope,
      store
    });
    result = await graph.execute(normalized.command);
  } catch (cause) {
    primary = readonlyError(cause);
  }

  if (graph !== undefined) {
    try {
      await graph.close();
    } catch (cause) {
      primary ??= readonlyError(cause);
    }
  }
  if (database !== undefined) {
    try {
      database.close();
    } catch (cause) {
      primary ??= readonlyError(cause);
    }
  }
  primary = await releaseLease(lease, primary);
  if (primary !== undefined) throw primary;
  return result!;
}
