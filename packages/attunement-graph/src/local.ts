import { types as nodeTypes } from "node:util";

import { createMagStore } from "./mag-backend.js";
import type {
  Mag,
  MagExecuteCommand,
  MagOperatorResult,
  MagProjectCommand,
  MagScope,
  MagSnapshot
} from "./mag-contracts.js";
import { openMag } from "./mag-engine.js";
import { MagError } from "./mag-error.js";
import { openSqliteMagStore } from "./mag-sqlite-store.js";

export interface OpenLocalMagOptions {
  readonly databasePath: string;
  readonly scope: MagScope;
}

type DataRecord = Record<string, unknown>;

function dataRecord(
  value: unknown,
  label: string,
  allowed: readonly string[],
  required: readonly string[]
): DataRecord {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || nodeTypes.isProxy(value)
  ) {
    throw new MagError("INVALID_INPUT", `${label} must be a non-proxy plain object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new MagError("INVALID_INPUT", `${label} must be a plain object`);
  }
  const keys = Reflect.ownKeys(value);
  if (
    keys.some((key) => typeof key !== "string" || !allowed.includes(key))
    || required.some((key) => !keys.includes(key))
  ) {
    throw new MagError("INVALID_INPUT", `${label} has invalid fields`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    keys.some((key) => {
      if (typeof key !== "string") return true;
      const descriptor = descriptors[key];
      return descriptor === undefined || !("value" in descriptor);
    })
  ) {
    throw new MagError("INVALID_INPUT", `${label} fields must be data properties`);
  }
  return Object.fromEntries(
    keys.map((key) => [key, descriptors[key as string]!.value])
  );
}

function boundedText(value: unknown, label: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value !== value.trim()
    || value.length > 512
  ) {
    throw new MagError("INVALID_INPUT", `${label} must be bounded non-empty text`);
  }
  return value;
}

function normalizeOptions(value: unknown): OpenLocalMagOptions {
  const options = dataRecord(
    value,
    "open local MAG options",
    ["databasePath", "scope"],
    ["databasePath", "scope"]
  );
  const rawScope = dataRecord(
    options.scope,
    "open local MAG options.scope",
    ["sourceId", "threadId"],
    ["sourceId", "threadId"]
  );
  if (typeof options.databasePath !== "string") {
    throw new MagError(
      "INVALID_INPUT",
      "open local MAG options.databasePath must be a string"
    );
  }
  return Object.freeze({
    databasePath: options.databasePath,
    scope: Object.freeze({
      sourceId: boundedText(
        rawScope.sourceId,
        "open local MAG options.scope.sourceId"
      ),
      threadId: boundedText(
        rawScope.threadId,
        "open local MAG options.scope.threadId"
      )
    })
  });
}

/**
 * Opens the durable local MAG Module.
 *
 * SQLite, SQL, Worker lifecycle, migrations, and physical profile details stay
 * behind this Interface. The existing MAG Engine remains the sole owner of
 * projection, replay, snapshot, and operator semantics.
 */
export async function openLocalMag(options: OpenLocalMagOptions): Promise<Mag> {
  const normalized = normalizeOptions(options);
  const resource = await openSqliteMagStore({
    databasePath: normalized.databasePath
  });
  let engine: Mag;
  try {
    engine = await openMag({
      scope: normalized.scope,
      store: createMagStore(resource.backend)
    });
  } catch (cause) {
    await resource.close().catch(() => undefined);
    throw cause;
  }

  let lifecycle: "open" | "closing" | "closed" = "open";
  let closePromise: Promise<void> | undefined;

  const rejectClosed = <T>(): Promise<T> =>
    Promise.reject(new MagError("CLOSED", "local MAG instance is closing or closed"));

  return Object.freeze({
    project(command: MagProjectCommand) {
      return lifecycle === "open"
        ? engine.project(command)
        : rejectClosed<MagSnapshot>();
    },
    execute(command: MagExecuteCommand) {
      return lifecycle === "open"
        ? engine.execute(command)
        : rejectClosed<MagOperatorResult>();
    },
    close() {
      if (closePromise) return closePromise;
      lifecycle = "closing";
      const engineClose = engine.close();
      closePromise = engineClose
        .then(() => resource.close())
        .finally(() => {
          lifecycle = "closed";
        });
      return closePromise;
    }
  });
}
