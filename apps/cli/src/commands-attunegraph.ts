import path from "node:path";

import {
  AttuneGraphAdminReadonlyError,
  openAttuneGraphAdminReadonlyApplication,
  type AttuneGraphAdminErrorCode,
  type AttuneGraphAdminHeadResult,
  type AttuneGraphAdminReadonlyApplication,
  type AttuneGraphAdminStoreSummary,
  type AttuneGraphScope,
  type OpenAttuneGraphAdminReadonlyApplicationOptions
} from "@attunegraph/core/admin";
import type { Command } from "commander";

import type { ProgramIO } from "./program.js";

type AttuneGraphCliInputErrorCode =
  | "DATABASE_REQUIRED"
  | "INVALID_DATABASE_PATH"
  | "SOURCE_STATE_REQUIRED"
  | "INVALID_SCOPE_OPTIONS";

type AttuneGraphInspectErrorCode =
  | AttuneGraphCliInputErrorCode
  | AttuneGraphAdminErrorCode
  | "OPERATION_FAILED";

interface AttuneGraphInspectOptions {
  readonly database?: string;
  readonly sourceState?: string;
  readonly sourceId?: string;
  readonly threadId?: string;
  readonly verify?: boolean;
  readonly json?: boolean;
}

interface AttuneGraphInspectData {
  readonly store: Readonly<{
    readonly identity: "ATG1";
    readonly applicationId: number;
    readonly userVersion: number;
    readonly protocolVersion: number;
    readonly sqliteVersion: string;
    readonly headRows: number;
    readonly journalRows: number;
    readonly maxGeneration: number;
  }>;
  readonly integrity:
    | Readonly<{ readonly status: "not-requested" }>
    | Readonly<{ readonly status: "verified" }>;
  readonly head:
    | Readonly<{ readonly status: "not-requested" }>
    | Readonly<{ readonly status: "not-found" }>
    | Readonly<{
        readonly status: "found";
        readonly generation: number;
        readonly commitId: string;
        readonly projectionFingerprint: string;
      }>;
}

type OpenReadonlyApplication = (
  options: OpenAttuneGraphAdminReadonlyApplicationOptions
) => Promise<AttuneGraphAdminReadonlyApplication>;

export interface AttuneGraphCommandDeps {
  readonly openReadonlyApplication?: OpenReadonlyApplication;
}

const INPUT_ERROR_MESSAGES: Readonly<Record<AttuneGraphCliInputErrorCode, string>> =
  Object.freeze({
    DATABASE_REQUIRED: "Database path is required",
    INVALID_DATABASE_PATH: "Database path must be absolute and normalized",
    SOURCE_STATE_REQUIRED: "Source state must be explicitly closed-quiescent",
    INVALID_SCOPE_OPTIONS: "Source ID and thread ID must be non-empty and provided together"
  });

const ADMIN_ERROR_MESSAGES: Readonly<Record<AttuneGraphAdminErrorCode, string>> =
  Object.freeze({
    INVALID_INPUT: "Admin request is invalid",
    INVALID_STATE: "Admin application is not available",
    REENTRY: "Admin application already has an active operation",
    SOURCE_NOT_FOUND: "Admin source was not found",
    UNSUPPORTED_PROFILE: "Admin store profile is unsupported",
    CORRUPT_STORE: "Admin store is corrupt",
    FUTURE_STORE_STATE: "Admin store version is unsupported",
    STORE_BUSY: "Admin store is busy",
    TIMED_OUT: "Admin operation timed out",
    WORKER_FAILURE: "Admin worker failed"
  });

const CALLER_ERROR_CODES: ReadonlySet<AttuneGraphAdminErrorCode> = new Set([
  "INVALID_INPUT",
  "SOURCE_NOT_FOUND",
  "UNSUPPORTED_PROFILE"
]);

class AttuneGraphCliInputError extends Error {
  readonly code: AttuneGraphCliInputErrorCode;

  constructor(code: AttuneGraphCliInputErrorCode) {
    super(INPUT_ERROR_MESSAGES[code]);
    this.name = "AttuneGraphCliInputError";
    this.code = code;
  }
}

function validateDatabasePath(value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    throw new AttuneGraphCliInputError("DATABASE_REQUIRED");
  }
  if (
    value.includes("\0")
    || value.trim() !== value
    || !path.isAbsolute(value)
    || path.normalize(value) !== value
  ) {
    throw new AttuneGraphCliInputError("INVALID_DATABASE_PATH");
  }
  return value;
}

function validateSourceState(
  value: string | undefined
): "closed-quiescent" {
  if (value !== "closed-quiescent") {
    throw new AttuneGraphCliInputError("SOURCE_STATE_REQUIRED");
  }
  return value;
}

function optionalScope(
  sourceId: string | undefined,
  threadId: string | undefined
): AttuneGraphScope | undefined {
  const hasSource = sourceId !== undefined;
  const hasThread = threadId !== undefined;
  if (
    hasSource !== hasThread
    || (hasSource && (sourceId!.length === 0 || threadId!.length === 0))
  ) {
    throw new AttuneGraphCliInputError("INVALID_SCOPE_OPTIONS");
  }
  return hasSource ? { sourceId: sourceId!, threadId: threadId! } : undefined;
}

function headData(result: AttuneGraphAdminHeadResult): AttuneGraphInspectData["head"] {
  if (!result.found) return { status: "not-found" };
  return {
    status: "found",
    generation: result.head.generation,
    commitId: result.head.commitId,
    projectionFingerprint: result.head.projectionFingerprint
  };
}

function storeData(
  summary: AttuneGraphAdminStoreSummary
): AttuneGraphInspectData["store"] {
  return {
    identity: "ATG1",
    applicationId: summary.applicationId,
    userVersion: summary.userVersion,
    protocolVersion: summary.protocolVersion,
    sqliteVersion: summary.sqliteVersion,
    headRows: summary.headRows,
    journalRows: summary.journalRows,
    maxGeneration: summary.maxGeneration
  };
}

async function inspectClosedStore(
  options: AttuneGraphInspectOptions,
  openReadonlyApplication: OpenReadonlyApplication
): Promise<AttuneGraphInspectData> {
  const databasePath = validateDatabasePath(options.database);
  const sourceState = validateSourceState(options.sourceState);
  const scope = optionalScope(options.sourceId, options.threadId);
  const application = await openReadonlyApplication({
    databasePath,
    sourceState
  });

  let primaryFailure: unknown;
  let data: AttuneGraphInspectData | undefined;
  try {
    const summary = await application.inspectSummary();
    const integrity = options.verify
      ? await application.verifyIntegrity().then(() => ({ status: "verified" as const }))
      : { status: "not-requested" as const };
    const head = scope
      ? headData(await application.inspectHead(scope))
      : { status: "not-requested" as const };
    data = {
      store: storeData(summary),
      integrity,
      head
    };
  } catch (cause) {
    primaryFailure = cause;
  }

  try {
    await application.close();
  } catch (cause) {
    primaryFailure ??= cause;
  }

  if (primaryFailure !== undefined) throw primaryFailure;
  return data!;
}

function humanOutput(data: AttuneGraphInspectData): string {
  const head = data.head.status === "found"
    ? `generation ${data.head.generation.toString()}; commit ${data.head.commitId}; fingerprint ${data.head.projectionFingerprint}`
    : data.head.status === "not-found"
      ? "not found"
      : "not requested";
  return [
    "AttuneGraph Lens",
    `identity: ${data.store.identity}`,
    `application id: ${data.store.applicationId.toString()}`,
    `store schema: ${data.store.userVersion.toString()}`,
    `admin protocol: ${data.store.protocolVersion.toString()}`,
    `sqlite: ${data.store.sqliteVersion}`,
    `heads: ${data.store.headRows.toString()}`,
    `journal rows: ${data.store.journalRows.toString()}`,
    `max generation: ${data.store.maxGeneration.toString()}`,
    `integrity: ${data.integrity.status === "verified" ? "verified" : "not requested"}`,
    `head: ${head}`
  ].join("\n") + "\n";
}

function classifyFailure(cause: unknown): Readonly<{
  code: AttuneGraphInspectErrorCode;
  message: string;
  exitCode: 1 | 2;
}> {
  if (cause instanceof AttuneGraphCliInputError) {
    return {
      code: cause.code,
      message: INPUT_ERROR_MESSAGES[cause.code],
      exitCode: 2
    };
  }
  if (cause instanceof AttuneGraphAdminReadonlyError) {
    return {
      code: cause.code,
      message: ADMIN_ERROR_MESSAGES[cause.code],
      exitCode: CALLER_ERROR_CODES.has(cause.code) ? 2 : 1
    };
  }
  return {
    code: "OPERATION_FAILED",
    message: "AttuneGraph inspection failed",
    exitCode: 1
  };
}

function writeFailure(
  io: ProgramIO,
  options: AttuneGraphInspectOptions,
  cause: unknown
): void {
  const failure = classifyFailure(cause);
  process.exitCode = failure.exitCode;
  if (options.json) {
    io.stdout(`${JSON.stringify({
      schemaVersion: 1,
      ok: false,
      command: "attunegraph.inspect",
      error: {
        code: failure.code,
        message: failure.message
      }
    })}\n`);
    return;
  }
  io.stderr(
    `AttuneGraph Lens error [${failure.code}]: ${failure.message}\n`
  );
}

export function registerAttuneGraphCommands(
  program: Command,
  io: ProgramIO,
  deps: AttuneGraphCommandDeps = {}
): void {
  const attuneGraph = program
    .command("attunegraph")
    .description("Inspect AttuneGraph stores through the local read-only Lens");

  attuneGraph
    .command("inspect")
    .description("Inspect one explicitly closed, quiescent AttuneGraph SQLite store")
    .option("--database <absolute-path>", "Absolute normalized database path (required)")
    .option(
      "--source-state <state>",
      "Required lifecycle attestation: closed-quiescent"
    )
    .option("--source-id <id>", "Exact source scope (requires --thread-id)")
    .option("--thread-id <id>", "Exact thread scope (requires --source-id)")
    .option("--verify", "Verify SQLite integrity before reading an optional head")
    .option("--json", "Emit one machine-readable JSON document")
    .addHelpText("after", `
The source database must be stopped and quiescent. Snapshot copying can detect
changes during inspection, but cannot prove the source lifecycle for you.

Example:
  muse attunegraph inspect --database /absolute/path/attunegraph.sqlite \\
    --source-state closed-quiescent --verify --json`)
    .action(async (options: AttuneGraphInspectOptions) => {
      try {
        const data = await inspectClosedStore(
          options,
          deps.openReadonlyApplication
            ?? openAttuneGraphAdminReadonlyApplication
        );
        if (options.json) {
          io.stdout(`${JSON.stringify({
            schemaVersion: 1,
            ok: true,
            command: "attunegraph.inspect",
            data
          })}\n`);
        } else {
          io.stdout(humanOutput(data));
        }
      } catch (cause) {
        writeFailure(io, options, cause);
      }
    });
}
