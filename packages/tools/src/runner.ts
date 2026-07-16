import { errorMessage, isRecord, redactSecretsInText, runCommandWithTimeout, type JsonObject } from "@muse/shared";
import { spawn, type ChildProcess } from "node:child_process";

import { classifyDangerousCommand } from "./dangerous-command.js";
import { classifyRunnerFailure, type RunnerFailureKind } from "./runner-failure.js";
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
  /**
   * Opt into network access under the seatbelt sandbox.
   * Caller-controlled ONLY — never read from model tool-args in
   * `parseRunnerCommandRequest`, so the model can never grant itself network access.
   */
  readonly allowNetwork?: boolean;
}

export interface RunnerCommandResponse {
  readonly ok: boolean;
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly error: string | null;
  /** TX-11: deterministic failure category, present only on a failed result. */
  readonly failureKind?: RunnerFailureKind;
  /** Set when the seatbelt sandbox was requested but this platform can't honor it. */
  readonly sandboxWarning?: string;
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
          maxOutputBytes: { maximum: MAX_RUNNER_OUTPUT_BYTES, minimum: 1, type: "integer" },
          timeoutMs: { description: "Kill the command after this many milliseconds, e.g. 5000.", maximum: MAX_RUNNER_TIMEOUT_MS, minimum: 1, type: "integer" }
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

      const cap = request.maxOutputBytes;
      const cappedStdout = cap !== undefined ? truncateUtf8(response.stdout, cap) : response.stdout;
      const cappedStderr = cap !== undefined ? truncateUtf8(response.stderr, cap) : response.stderr;
      // A model-supplied cap that actually shortened either stream MUST flip
      // `truncated` — otherwise the model reads partial output as if it were the
      // whole thing and concludes wrongly (e.g. "tests passed" off a cut log).
      // OR with the runner's own flag; never flip a genuine `true` back to false.
      // Computed on the CAPPED-but-UNREDACTED strings — redaction changes length
      // (a secret collapses to `[redacted-...]`), which would corrupt this compare.
      const capTruncated = cappedStdout !== response.stdout || cappedStderr !== response.stderr;

      // Subprocess output is untrusted and can echo a secret (an env dump, a
      // config print, a leaked credential in a log line) — mask before it
      // enters the model context.
      const stdout = redactSecretsInText(cappedStdout);
      const stderr = redactSecretsInText(cappedStderr);

      const failureKind = classifyRunnerFailure({ status: response.status, stderr, timedOut: response.timedOut, error: response.error });
      return {
        ...response,
        stderr,
        stdout,
        truncated: response.truncated || capTruncated,
        ...(failureKind ? { failureKind } : {})
      };
    }
  };
}

/**
 * Truncate a string to a UTF-8 byte budget without producing a replacement
 * character from a partial multibyte sequence. The Rust runner already uses
 * byte caps; this protects injected and fallback runner implementations too.
 */
function truncateUtf8(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value);
  if (bytes.byteLength <= maxBytes) {
    return value;
  }

  let end = maxBytes;
  let continuationStart = end;
  while (continuationStart > 0 && isUtf8ContinuationByte(bytes[continuationStart - 1]!)) {
    continuationStart--;
  }

  if (continuationStart === end) {
    if (utf8SequenceLength(bytes[end - 1]!) > 1) {
      end--;
    }
  } else {
    const leadIndex = continuationStart - 1;
    if (leadIndex < 0 || utf8SequenceLength(bytes[leadIndex]!) !== end - leadIndex) {
      end = Math.max(0, leadIndex);
    }
  }

  return bytes.subarray(0, end).toString("utf8");
}

function isUtf8ContinuationByte(value: number): boolean {
  return (value & 0b1100_0000) === 0b1000_0000;
}

function utf8SequenceLength(leadByte: number): number {
  if ((leadByte & 0b1000_0000) === 0) return 1;
  if ((leadByte & 0b1110_0000) === 0b1100_0000) return 2;
  if ((leadByte & 0b1111_0000) === 0b1110_0000) return 3;
  if ((leadByte & 0b1111_1000) === 0b1111_0000) return 4;
  return 1;
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
  try {
    const responseText = JSON.stringify(request);
    const result = await runCommandWithTimeout({
      command: runnerPath,
      stdin: `${responseText}\n`,
      timeoutMs: runnerWatchdogMs(request),
      spawnImpl: spawn,
      // The Rust runner puts each command in its own process group. If this
      // outer watchdog kills a wedged runner, kill that whole inherited group
      // too; otherwise a backgrounded command can survive its runner parent.
      killProcessGroup: true,
      maxStdoutBytes: 200_000,
      maxStderrBytes: 200_000
    });

    if (result.timedOut) {
      return {
        error: `runner process exceeded the ${runnerWatchdogMs(request).toString()}ms watchdog and was killed`,
        ok: false,
        status: null,
        stderr: result.stderr,
        stdout: result.stdout,
        timedOut: true,
        truncated: false
      };
    }

    if (result.truncated) {
      return {
        error: "runner process output exceeded the 200000 byte capture limit",
        ok: false,
        status: null,
        stderr: result.stderr,
        stdout: result.stdout,
        timedOut: false,
        truncated: true
      };
    }

    const parsed = parseRunnerResponse(result.stdout);
    if (parsed) {
      return parsed;
    }

    return {
      error: "runner returned invalid JSON",
      ok: false,
      status: null,
      stderr: result.stderr,
      stdout: result.stdout,
      timedOut: false,
      truncated: false
    };
  } catch (cause) {
    return {
      error: errorMessage(cause),
      ok: false,
      status: null,
      stderr: "",
      stdout: "",
      timedOut: false,
      truncated: false
    };
  }
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

  // Fail-close on an irreversible catastrophic command (root/home recursive
  // delete, fork bomb, raw-device write, mkfs) — refused in CODE, not left to
  // the approval gate which an auto-approve mode could bypass. Classified on
  // the reconstructed full line so a `rm`/`-rf /` split across command+args is
  // still caught.
  const danger = classifyDangerousCommand([command, ...(args ?? [])].join(" "));
  if (danger.dangerous) {
    throw new ToolRegistryError(`run_command refused: ${danger.reason} — irreversible, blocked in code`);
  }

  return {
    args,
    command,
    cwd: typeof value.cwd === "string" && value.cwd.trim().length > 0 ? value.cwd : undefined,
    env: readStringRecord(value.env),
    maxOutputBytes: readPositiveInteger(value.maxOutputBytes, MAX_RUNNER_OUTPUT_BYTES),
    timeoutMs: readPositiveInteger(value.timeoutMs, MAX_RUNNER_TIMEOUT_MS)
  };
}

const MAX_RUNNER_EXIT_CODE = 0x7fff_ffff;

function isRunnerExitCode(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_RUNNER_EXIT_CODE;
}

function parseRunnerResponse(value: string): RunnerCommandResponse | undefined {
  try {
    const parsed = JSON.parse(value);

    if (!isRecord(parsed)) {
      return undefined;
    }

    return {
      error: typeof parsed.error === "string" ? parsed.error : null,
      ok: parsed.ok === true,
      status: isRunnerExitCode(parsed.status) ? parsed.status : null,
      stderr: typeof parsed.stderr === "string" ? parsed.stderr : "",
      stdout: typeof parsed.stdout === "string" ? parsed.stdout : "",
      timedOut: parsed.timedOut === true,
      truncated: parsed.truncated === true,
      ...(typeof parsed.sandboxWarning === "string" ? { sandboxWarning: parsed.sandboxWarning } : {})
    };
  } catch {
    return undefined;
  }
}

/**
 * Env vars that load/run arbitrary CODE at process launch — they bypass the
 * runner's no-shell `Command::new` + path-reject guards (which only constrain
 * WHICH binary runs, not what's injected into it). A model-run command never
 * legitimately needs them, so they are dropped before reaching the runner
 * (defence-in-depth; the Rust runner rejects the same set). Covers: the dynamic
 * loader (`LD_*` glibc / `DYLD_*` macOS), and a per-runtime set of code-injection
 * vars — `NODE_OPTIONS` (--require/--import), shell startup (`BASH_ENV`/`ENV`),
 * interpreter option/path injection (perl/python/ruby), and git's command-exec
 * hooks (`GIT_SSH_COMMAND`/`GIT_EXTERNAL_DIFF`/…).
 */
const UNSAFE_ENV_EXACT: ReadonlySet<string> = new Set([
  "NODE_OPTIONS", "NODE_PATH",
  "BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS",
  "PERL5OPT", "PERL5DB", "PERLLIB", "PERL5LIB",
  "PYTHONSTARTUP", "PYTHONPATH", "PYTHONINSPECT", "PYTHONHOME",
  "RUBYOPT", "RUBYLIB", "GEM_HOME", "GEM_PATH",
  // JVM reads *_JAVA_OPTIONS on startup and honors `-javaagent:` — code exec on
  // any java/javac/gradle/mvn. CLASSPATH / LESSOPEN are the same module/hook class.
  "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS", "CLASSPATH", "LESSOPEN",
  // PATH is the ONLY resolution path for a bare command name (the runner rejects
  // a `/` in the command), so a model-set PATH redirects a guard-passing name
  // (`git`) to an attacker binary — fully bypassing the command guard. Strip it;
  // the runner's own PATH resolves normal commands.
  "PATH",
  "GIT_SSH_COMMAND", "GIT_SSH", "GIT_EXTERNAL_DIFF", "GIT_PAGER", "GIT_EDITOR", "GIT_PROXY_COMMAND", "GIT_ASKPASS",
  // GIT_CONFIG* point git at an attacker-controlled config that can set
  // core.sshCommand / core.pager / core.fsmonitor — a second path to the same
  // command-exec hooks blocked above.
  "GIT_CONFIG", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM"
]);

function isUnsafeEnvKey(key: string): boolean {
  return /^(?:LD|DYLD)_/u.test(key) || UNSAFE_ENV_EXACT.has(key);
}

function readStringRecord(value: unknown): Readonly<Record<string, string>> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string" && !isUnsafeEnvKey(entry[0])
    )
  );
}

/**
 * Upper bounds on the model-controlled resource knobs. `timeoutMs`/`maxOutputBytes`
 * have only a lower bound (≥1), so a huge value would hang the runner for days or
 * buffer unbounded output into memory. Clamp to a generous-but-finite ceiling
 * (10 min / 10 MB) — the Rust runner clamps to the same, defence-in-depth.
 */
export const MAX_RUNNER_TIMEOUT_MS = 600_000;
export const MAX_RUNNER_OUTPUT_BYTES = 10 * 1024 * 1024;

function readPositiveInteger(value: unknown, max?: number): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return undefined;
  }
  return max !== undefined ? Math.min(value, max) : value;
}
