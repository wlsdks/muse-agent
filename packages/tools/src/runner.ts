import { Buffer } from "node:buffer";
import { isRecord } from "@muse/shared";
import { spawn, type ChildProcess } from "node:child_process";

import type { JsonObject } from "@muse/shared";

import { ToolRegistryError, type MuseTool } from "./index.js";

/**
 * Rust runner integration — invokes the `muse-runner` child process
 * (compiled from `crates/runner`) for risky local execution flows.
 *
 * Lifted out of `packages/tools/src/index.ts` so the runner-protocol
 * code (request encoding, JSON-line response parsing, child-process
 * lifecycle) lives in one cohesive module. Re-exported from
 * `index.ts` so the `@muse/tools` barrel and existing tests keep
 * working without import-site edits.
 */

export interface RunnerCommandRequest {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
}

export interface RunnerCommandResponse {
  readonly ok: boolean;
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly error: string | null;
}

export interface RustRunnerToolOptions {
  readonly runnerPath?: string;
  readonly invokeRunner?: (request: RunnerCommandRequest) => Promise<RunnerCommandResponse>;
}

export function createRustRunnerTool(options: RustRunnerToolOptions = {}): MuseTool {
  const invoke = options.invokeRunner ?? ((request) => invokeRustRunner(options.runnerPath ?? "muse-runner", request));

  return {
    definition: {
      description: "Execute an approved local command through the Muse Rust runner child process.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          args: { items: { type: "string" }, type: "array" },
          command: { type: "string" },
          cwd: { type: "string" },
          env: { additionalProperties: { type: "string" }, type: "object" },
          maxOutputBytes: { minimum: 1, type: "integer" },
          timeoutMs: { minimum: 1, type: "integer" }
        },
        required: ["command"],
        type: "object"
      },
      domain: "system",
      name: "run_command",
      risk: "execute"
    },
    async execute(args) {
      const request = parseRunnerCommandRequest(args);
      const response = await invoke(request);

      return {
        ...response,
        stderr: response.stderr.slice(0, request.maxOutputBytes ?? response.stderr.length),
        stdout: response.stdout.slice(0, request.maxOutputBytes ?? response.stdout.length)
      };
    }
  };
}

const RUNNER_WATCHDOG_GRACE_MS = 5_000;
const DEFAULT_RUNNER_WATCHDOG_MS = 120_000;

/**
 * TS-side watchdog cap. The command timeout itself is enforced by
 * the Rust runner (it reports `timedOut`), so the watchdog only
 * guards against the runner *process* wedging (deadlock, zombie,
 * never closing stdout). It must outlast the runner's own deadline
 * by a grace margin so a legitimately long approved command isn't
 * killed before the runner can enforce + report its timeout.
 */
export function runnerWatchdogMs(request: RunnerCommandRequest): number {
  return request.timeoutMs !== undefined
    ? request.timeoutMs + RUNNER_WATCHDOG_GRACE_MS
    : DEFAULT_RUNNER_WATCHDOG_MS;
}

export async function invokeRustRunner(
  runnerPath: string,
  request: RunnerCommandRequest
): Promise<RunnerCommandResponse> {
  return new Promise((resolve) => {
    const child = spawn(runnerPath, [], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    const settle = (response: RunnerCommandResponse): void => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      resolve(response);
    };

    const watchdog = setTimeout(() => {
      const alreadySettled = settled;
      child.kill("SIGKILL");
      if (!alreadySettled) {
        settle({
          error: `runner process exceeded the ${runnerWatchdogMs(request).toString()}ms watchdog and was killed`,
          ok: false,
          status: null,
          stderr: Buffer.concat(stderr).toString("utf8"),
          stdout: Buffer.concat(stdout).toString("utf8"),
          timedOut: true,
          truncated: false
        });
      }
    }, runnerWatchdogMs(request));

    attachReadStreamErrorAbsorber(child.stdout);
    attachReadStreamErrorAbsorber(child.stderr);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      settle({
        error: error.message,
        ok: false,
        status: null,
        stderr: "",
        stdout: "",
        timedOut: false,
        truncated: false
      });
    });
    child.on("close", () => {
      const output = Buffer.concat(stdout).toString("utf8");
      const parsed = parseRunnerResponse(output);

      if (parsed) {
        settle(parsed);
        return;
      }

      settle({
        error: "runner returned invalid JSON",
        ok: false,
        status: null,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: output,
        timedOut: false,
        truncated: false
      });
    });
    writeRunnerStdin(child, request);
  });
}

/**
 * Pipe the JSON request into the runner child's stdin. A runner that exits
 * before consuming stdin (binary missing, immediate panic, watchdog SIGKILL)
 * closes the pipe and the parent's `end(...)` then emits an EPIPE error on
 * the stdin Writable. Without a registered listener the unhandled `error`
 * crashes the parent Node process — same hazard piper.ts defends against.
 * Exported for direct test coverage of the error-listener registration.
 */
export function writeRunnerStdin(child: ChildProcess, request: RunnerCommandRequest): void {
  const stdin = child.stdin;
  if (!stdin) return;
  stdin.on("error", () => undefined);
  stdin.end(`${JSON.stringify(request)}\n`);
}

/**
 * Register a no-op `error` listener on a Readable stream so an OS-level
 * pipe error (rare but possible — kernel pipe corruption, sandbox
 * tear-down mid-read) doesn't crash the parent via EventEmitter's
 * "unhandled error" contract. Symmetric to the stdin write-side
 * absorber on the runner; the close handler reports the exit code.
 */
export function attachReadStreamErrorAbsorber(stream: NodeJS.ReadableStream | null): void {
  if (!stream) return;
  stream.on("error", () => undefined);
}

export function parseRunnerCommandRequest(value: JsonObject): RunnerCommandRequest {
  const command = typeof value.command === "string" ? value.command.trim() : "";

  if (!command) {
    throw new ToolRegistryError("run_command requires a non-empty command");
  }

  return {
    args: Array.isArray(value.args) ? value.args.filter((entry): entry is string => typeof entry === "string") : undefined,
    command,
    cwd: typeof value.cwd === "string" && value.cwd.trim().length > 0 ? value.cwd : undefined,
    env: readStringRecord(value.env),
    maxOutputBytes: readPositiveInteger(value.maxOutputBytes),
    timeoutMs: readPositiveInteger(value.timeoutMs)
  };
}

function parseRunnerResponse(value: string): RunnerCommandResponse | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;

    if (!isRecord(parsed)) {
      return undefined;
    }

    return {
      error: typeof parsed.error === "string" ? parsed.error : null,
      ok: parsed.ok === true,
      status: typeof parsed.status === "number" ? parsed.status : null,
      stderr: typeof parsed.stderr === "string" ? parsed.stderr : "",
      stdout: typeof parsed.stdout === "string" ? parsed.stdout : "",
      timedOut: parsed.timedOut === true,
      truncated: parsed.truncated === true
    };
  } catch {
    return undefined;
  }
}

function readStringRecord(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

