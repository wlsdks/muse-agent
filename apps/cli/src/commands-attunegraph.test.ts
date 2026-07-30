import { tmpdir } from "node:os";
import path from "node:path";

import {
  AttuneGraphAdminReadonlyError,
  type AttuneGraphAdminErrorCode,
  type AttuneGraphAdminReadonlyApplication,
  type AttuneGraphAdminStoreSummary
} from "@attunegraph/core/admin";
import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  registerAttuneGraphCommands,
  type AttuneGraphCommandDeps
} from "./commands-attunegraph.js";
import type { ProgramIO } from "./program.js";

const DATABASE_PATH = path.join(
  tmpdir(),
  "private-attunegraph-sentinel.sqlite"
);
const SUMMARY: AttuneGraphAdminStoreSummary = Object.freeze({
  applicationId: 0x41544731,
  userVersion: 1,
  protocolVersion: 1,
  sqliteVersion: "3.50.4",
  headRows: 2,
  journalRows: 7,
  maxGeneration: 4
});
const BASE_ARGS = [
  "attunegraph",
  "inspect",
  "--database",
  DATABASE_PATH,
  "--source-state",
  "closed-quiescent"
] as const;

interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | undefined;
}

function application(
  overrides: Partial<AttuneGraphAdminReadonlyApplication> = {}
): AttuneGraphAdminReadonlyApplication {
  return {
    inspectSummary: vi.fn(async () => SUMMARY),
    inspectHead: vi.fn(async () => ({ found: false as const })),
    verifyIntegrity: vi.fn(async () => ({ verified: true as const })),
    close: vi.fn(async () => undefined),
    [Symbol.asyncDispose]: vi.fn(async () => undefined),
    ...overrides
  };
}

async function runCommand(
  args: readonly string[],
  deps: AttuneGraphCommandDeps
): Promise<RunResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: ProgramIO = {
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message)
  };
  const program = new Command()
    .name("muse")
    .exitOverride()
    .configureOutput({
      writeOut: io.stdout,
      writeErr: io.stderr
    });
  registerAttuneGraphCommands(program, io, deps);
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await program.parseAsync([...args], { from: "user" });
    return {
      stdout: stdout.join(""),
      stderr: stderr.join(""),
      exitCode: process.exitCode
    };
  } finally {
    process.exitCode = previousExitCode;
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AttuneGraph Lens success", () => {
  it("renders the exact human summary after ordered operations and close", async () => {
    const trace: string[] = [];
    const opened = application({
      inspectSummary: vi.fn(async () => {
        trace.push("summary");
        return SUMMARY;
      }),
      verifyIntegrity: vi.fn(async () => {
        trace.push("integrity");
        return { verified: true as const };
      }),
      inspectHead: vi.fn(async (scope) => {
        trace.push("head");
        expect(scope).toEqual({
          sourceId: "notes",
          threadId: "trip-planning"
        });
        return {
          found: true,
          head: {
            scope,
            generation: 4,
            commitId: "commit-4",
            projectionFingerprint: "fingerprint-4"
          }
        };
      }),
      close: vi.fn(async () => {
        trace.push("close");
      })
    });
    const opener = vi.fn(async () => opened);

    const result = await runCommand([
      ...BASE_ARGS,
      "--verify",
      "--source-id",
      "notes",
      "--thread-id",
      "trip-planning"
    ], { openReadonlyApplication: opener });

    expect(opener).toHaveBeenCalledWith({
      databasePath: DATABASE_PATH,
      sourceState: "closed-quiescent"
    });
    expect(trace).toEqual(["summary", "integrity", "head", "close"]);
    expect(result).toEqual({
      stdout: [
        "AttuneGraph Lens",
        "identity: ATG1",
        "application id: 1096042289",
        "store schema: 1",
        "admin protocol: 1",
        "sqlite: 3.50.4",
        "heads: 2",
        "journal rows: 7",
        "max generation: 4",
        "integrity: verified",
        "head: generation 4; commit commit-4; fingerprint fingerprint-4",
        ""
      ].join("\n"),
      stderr: "",
      exitCode: undefined
    });
    expect(result.stdout).not.toContain(DATABASE_PATH);
    expect(result.stdout).not.toContain("trip-planning");
  });

  it("emits the exact single JSON envelope for not-requested operations", async () => {
    const opened = application();
    const result = await runCommand([...BASE_ARGS, "--json"], {
      openReadonlyApplication: vi.fn(async () => opened)
    });

    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      ok: true,
      command: "attunegraph.inspect",
      data: {
        store: {
          identity: "ATG1",
          applicationId: 1096042289,
          userVersion: 1,
          protocolVersion: 1,
          sqliteVersion: "3.50.4",
          headRows: 2,
          journalRows: 7,
          maxGeneration: 4
        },
        integrity: { status: "not-requested" },
        head: { status: "not-requested" }
      }
    });
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(opened.inspectHead).not.toHaveBeenCalled();
    expect(opened.verifyIntegrity).not.toHaveBeenCalled();
    expect(opened.close).toHaveBeenCalledOnce();
  });

  it("renders an exact not-found head state without echoing the scope", async () => {
    const result = await runCommand([
      ...BASE_ARGS,
      "--source-id",
      "private-source",
      "--thread-id",
      "private-thread",
      "--json"
    ], {
      openReadonlyApplication: vi.fn(async () => application())
    });

    expect(JSON.parse(result.stdout).data.head).toEqual({
      status: "not-found"
    });
    expect(result.stdout).not.toContain("private-source");
    expect(result.stdout).not.toContain("private-thread");
  });

  it("does not emit partial output before close settles", async () => {
    let releaseClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const opened = application({
      close: vi.fn(() => closeGate)
    });
    const stdout: string[] = [];
    const io: ProgramIO = {
      stdout: (message) => stdout.push(message),
      stderr: vi.fn()
    };
    const program = new Command().name("muse");
    registerAttuneGraphCommands(program, io, {
      openReadonlyApplication: vi.fn(async () => opened)
    });
    const parsing = program.parseAsync([...BASE_ARGS, "--json"], {
      from: "user"
    });

    await vi.waitFor(() => expect(opened.close).toHaveBeenCalledOnce());
    expect(stdout).toEqual([]);
    releaseClose();
    await parsing;
    expect(stdout).toHaveLength(1);
  });
});

describe("AttuneGraph Lens validation", () => {
  it.each([
    {
      name: "missing database",
      args: ["attunegraph", "inspect", "--source-state", "closed-quiescent"],
      code: "DATABASE_REQUIRED",
      message: "Database path is required",
      sensitivePath: undefined
    },
    {
      name: "non-normalized database",
      args: [
        "attunegraph", "inspect", "--database", `${tmpdir()}/x/../secret.sqlite`,
        "--source-state", "closed-quiescent"
      ],
      code: "INVALID_DATABASE_PATH",
      message: "Database path must be absolute and normalized",
      sensitivePath: `${tmpdir()}/x/../secret.sqlite`
    },
    {
      name: "missing source state",
      args: ["attunegraph", "inspect", "--database", DATABASE_PATH],
      code: "SOURCE_STATE_REQUIRED",
      message: "Source state must be explicitly closed-quiescent",
      sensitivePath: DATABASE_PATH
    },
    {
      name: "wrong source state",
      args: [
        "attunegraph", "inspect", "--database", DATABASE_PATH,
        "--source-state", "live"
      ],
      code: "SOURCE_STATE_REQUIRED",
      message: "Source state must be explicitly closed-quiescent",
      sensitivePath: DATABASE_PATH
    },
    {
      name: "missing thread mate",
      args: [...BASE_ARGS, "--source-id", "notes"],
      code: "INVALID_SCOPE_OPTIONS",
      message: "Source ID and thread ID must be non-empty and provided together",
      sensitivePath: DATABASE_PATH
    },
    {
      name: "empty source id",
      args: [...BASE_ARGS, "--source-id", "", "--thread-id", "thread"],
      code: "INVALID_SCOPE_OPTIONS",
      message: "Source ID and thread ID must be non-empty and provided together",
      sensitivePath: DATABASE_PATH
    }
  ])("rejects $name before opening", async ({ args, code, message, sensitivePath }) => {
    for (const json of [false, true]) {
      const opener = vi.fn();
      const result = await runCommand([
        ...args,
        ...(json ? ["--json"] : [])
      ], { openReadonlyApplication: opener });

      expect(opener).not.toHaveBeenCalled();
      expect(result.exitCode).toBe(2);
      if (json) {
        expect(JSON.parse(result.stdout)).toEqual({
          schemaVersion: 1,
          ok: false,
          command: "attunegraph.inspect",
          error: { code, message }
        });
      } else {
        expect(result).toMatchObject({
          stdout: "",
          stderr: `AttuneGraph Lens error [${code}]: ${message}\n`
        });
      }
      if (sensitivePath !== undefined) {
        expect(`${result.stdout}${result.stderr}`).not.toContain(sensitivePath);
      }
    }
  });
});

describe("AttuneGraph Lens failures and cleanup", () => {
  const cases: readonly Readonly<{
    code: AttuneGraphAdminErrorCode;
    message: string;
    exitCode: 1 | 2;
  }>[] = [
    { code: "INVALID_INPUT", message: "Admin request is invalid", exitCode: 2 },
    { code: "SOURCE_NOT_FOUND", message: "Admin source was not found", exitCode: 2 },
    { code: "UNSUPPORTED_PROFILE", message: "Admin store profile is unsupported", exitCode: 2 },
    { code: "INVALID_STATE", message: "Admin application is not available", exitCode: 1 },
    { code: "REENTRY", message: "Admin application already has an active operation", exitCode: 1 },
    { code: "CORRUPT_STORE", message: "Admin store is corrupt", exitCode: 1 },
    { code: "FUTURE_STORE_STATE", message: "Admin store version is unsupported", exitCode: 1 },
    { code: "STORE_BUSY", message: "Admin store is busy", exitCode: 1 },
    { code: "TIMED_OUT", message: "Admin operation timed out", exitCode: 1 },
    { code: "WORKER_FAILURE", message: "Admin worker failed", exitCode: 1 }
  ];

  it.each(cases)("maps $code to its fixed human and JSON errors", async ({ code, message, exitCode }) => {
    for (const json of [false, true]) {
      const result = await runCommand([
        ...BASE_ARGS,
        ...(json ? ["--json"] : [])
      ], {
        openReadonlyApplication: vi.fn(async () => {
          throw new AttuneGraphAdminReadonlyError(code);
        })
      });

      expect(result.exitCode).toBe(exitCode);
      if (json) {
        expect(JSON.parse(result.stdout)).toEqual({
          schemaVersion: 1,
          ok: false,
          command: "attunegraph.inspect",
          error: { code, message }
        });
      } else {
        expect(result).toMatchObject({
          stdout: "",
          stderr: `AttuneGraph Lens error [${code}]: ${message}\n`
        });
      }
      expect(`${result.stdout}${result.stderr}`).not.toContain(DATABASE_PATH);
    }
  });

  it("keeps the operation error primary when close also fails", async () => {
    const opened = application({
      inspectSummary: vi.fn(async () => {
        throw new AttuneGraphAdminReadonlyError("CORRUPT_STORE");
      }),
      close: vi.fn(async () => {
        throw new AttuneGraphAdminReadonlyError("WORKER_FAILURE");
      })
    });
    const result = await runCommand(BASE_ARGS, {
      openReadonlyApplication: vi.fn(async () => opened)
    });

    expect(opened.close).toHaveBeenCalledOnce();
    expect(result).toEqual({
      stdout: "",
      stderr: "AttuneGraph Lens error [CORRUPT_STORE]: Admin store is corrupt\n",
      exitCode: 1
    });
  });

  it("promotes close failure only after successful operations", async () => {
    const opened = application({
      close: vi.fn(async () => {
        throw new AttuneGraphAdminReadonlyError("WORKER_FAILURE");
      })
    });
    const result = await runCommand([...BASE_ARGS, "--json"], {
      openReadonlyApplication: vi.fn(async () => opened)
    });

    expect(JSON.parse(result.stdout).error).toEqual({
      code: "WORKER_FAILURE",
      message: "Admin worker failed"
    });
    expect(result.stdout).not.toContain("\"data\"");
  });

  it.each([
    "open",
    "summary",
    "integrity",
    "head",
    "close"
  ] as const)("sanitizes an unexpected %s failure in human and JSON modes", async (phase) => {
    for (const json of [false, true]) {
      const unexpected = new Error(`private failure at ${DATABASE_PATH}`);
      const opened = application({
        inspectSummary: vi.fn(async () => {
          if (phase === "summary") throw unexpected;
          return SUMMARY;
        }),
        verifyIntegrity: vi.fn(async () => {
          if (phase === "integrity") throw unexpected;
          return { verified: true as const };
        }),
        inspectHead: vi.fn(async () => {
          if (phase === "head") throw unexpected;
          return { found: false as const };
        }),
        close: vi.fn(async () => {
          if (phase === "close") throw unexpected;
        })
      });
      const opener = vi.fn(async () => {
        if (phase === "open") throw unexpected;
        return opened;
      });
      const args = [
        ...BASE_ARGS,
        "--verify",
        "--source-id",
        "notes",
        "--thread-id",
        "thread",
        ...(json ? ["--json"] : [])
      ];
      const result = await runCommand(args, {
        openReadonlyApplication: opener
      });

      expect(result.exitCode).toBe(1);
      expect(`${result.stdout}${result.stderr}`).not.toContain(DATABASE_PATH);
      if (json) {
        expect(JSON.parse(result.stdout)).toEqual({
          schemaVersion: 1,
          ok: false,
          command: "attunegraph.inspect",
          error: {
            code: "OPERATION_FAILED",
            message: "AttuneGraph inspection failed"
          }
        });
      } else {
        expect(result.stderr).toBe(
          "AttuneGraph Lens error [OPERATION_FAILED]: AttuneGraph inspection failed\n"
        );
      }
      expect(opened.close).toHaveBeenCalledTimes(phase === "open" ? 0 : 1);
    }
  });
});
