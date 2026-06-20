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
      description:
        "Run a local program (a test, build, script, or shell utility) and get its stdout/stderr + exit " +
        "status back. Use when the task needs EXECUTING something — 'run the tests', 'build the project', " +
        "'what does this script print'. Do NOT use to read a file (file_read), search files (file_grep), or " +
        "list files (file_list) — those have dedicated tools.",
      inputSchema: {
        additionalProperties: false,
        properties: {
          args: {
            description: "Arguments as a SEPARATE list — e.g. ['report.mjs'] for `node report.mjs`, or ['-la', '/tmp'] for `ls -la /tmp`.",
            items: { type: "string" },
            type: "array"
          },
          command: {
            description: "The executable name ONLY — e.g. 'node', 'ls', 'pnpm'. NOT a full command line and NOT a path; put every argument in `args`.",
            type: "string"
          },
          cwd: { description: "Working directory to run in, e.g. '/Users/me/project'. Default: the current directory.", type: "string" },
          env: { additionalProperties: { type: "string" }, type: "object" },
          maxOutputBytes: { minimum: 1, type: "integer" },
          timeoutMs: { description: "Kill the command after this many milliseconds, e.g. 5000.", minimum: 1, type: "integer" }
        },
        required: ["command"],
        type: "object"
      },
      domain: "system",
      keywords: ["run", "command", "execute", "shell", "test", "compile", "실행", "명령", "테스트", "빌드"],
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
  let command = typeof value.command === "string" ? value.command.trim() : "";

  if (!command) {
    throw new ToolRegistryError("run_command requires a non-empty command");
  }

  let args = Array.isArray(value.args) ? value.args.filter((entry): entry is string => typeof entry === "string") : undefined;

  // The local model often packs the WHOLE command line into `command`
  // ("node report.mjs") — but the runner spawns the executable directly and
  // needs a bare name + a separate args list. When `command` carries whitespace
  // and no explicit args were given, split it. Quotes are left untouched (a naive
  // whitespace split would break a quoted argument like `echo "a b"`).
  if ((!args || args.length === 0) && /\s/u.test(command) && !/["']/u.test(command)) {
    const parts = command.split(/\s+/u);
    command = parts[0]!;
    args = parts.slice(1);
  }

  return {
    args,
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

/**
 * Dynamic-loader env vars hijack a process at launch — `LD_PRELOAD` /
 * `LD_LIBRARY_PATH` / `LD_AUDIT` (glibc) and `DYLD_INSERT_LIBRARIES` /
 * `DYLD_*_PATH` (macOS dyld) load arbitrary code INTO the spawned command,
 * escaping the runner's no-shell `Command::new` + path-reject guards. A model-run
 * command never legitimately needs them, so they are dropped before they reach
 * the runner (defence-in-depth; the Rust runner rejects them too).
 */
function isDynamicLoaderEnvKey(key: string): boolean {
  return /^(?:LD|DYLD)_/u.test(key);
}

function readStringRecord(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && !isDynamicLoaderEnvKey(entry[0])
    )
  );
}

function readPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

