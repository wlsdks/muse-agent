import { spawn as nodeSpawn } from "node:child_process";

export const MAX_EVAL_PROCESS_DEADLINE_MS = 12 * 60_000;
export const DEFAULT_EVAL_PROCESS_OUTPUT_BYTES = 1024 * 1024;
export const MAX_EVAL_PROCESS_OUTPUT_BYTES = 4 * 1024 * 1024;

const DEFAULT_KILL_GRACE_MS = 250;
const FINAL_KILL_SETTLE_MS = 50;

function positiveInteger(value, name, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`${name} must be a positive integer no greater than ${maximum.toString()}`);
  }
  return value;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function appendBounded(state, chunk, limit) {
  const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const remaining = Math.max(0, limit - state.bytes);
  if (remaining > 0) {
    const accepted = bytes.subarray(0, remaining);
    state.chunks.push(accepted);
    state.bytes += accepted.length;
  }
  if (bytes.length > remaining) state.truncated = true;
}

function ignoreMissingProcess(cause) {
  if (cause?.code !== "ESRCH") throw cause;
}

function signalOwnedPosixGroup(pid, signal, kill) {
  try {
    kill(-pid, signal);
  } catch (cause) {
    ignoreMissingProcess(cause);
  }
}

async function forceKillWindowsTree(pid, spawnControl) {
  let control;
  try {
    control = spawnControl(
      "taskkill",
      ["/PID", pid.toString(), "/T", "/F"],
      { stdio: "ignore", windowsHide: true }
    );
  } catch {
    return;
  }
  await Promise.race([
    new Promise((resolve) => {
      control.once("error", resolve);
      control.once("close", resolve);
    }),
    delay(FINAL_KILL_SETTLE_MS)
  ]);
}

/**
 * Run one evaluation process inside an owned process tree with a total deadline.
 *
 * On POSIX the direct child is a new process-group leader, so timeout cleanup
 * addresses exactly that negative pid and includes every descendant. Windows
 * uses taskkill /T /F after a short direct-child grace period. The caller's
 * deadline includes both cleanup stages; it is never a per-child 90-minute cap.
 */
export async function runBoundedEvalProcess(command, args, options) {
  if (typeof command !== "string" || command.length === 0) {
    throw new TypeError("command must be a non-empty string");
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
    throw new TypeError("args must be an array of strings");
  }
  if (!options || typeof options !== "object") {
    throw new TypeError("options are required");
  }
  const deadlineMs = positiveInteger(
    options.deadlineMs,
    "deadlineMs",
    MAX_EVAL_PROCESS_DEADLINE_MS
  );
  const killGraceMs = positiveInteger(
    options.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
    "killGraceMs",
    deadlineMs
  );
  if (killGraceMs + (2 * FINAL_KILL_SETTLE_MS) >= deadlineMs) {
    throw new TypeError("deadlineMs must leave time for graceful and forced cleanup");
  }
  const maxOutputBytes = positiveInteger(
    options.maxOutputBytes ?? DEFAULT_EVAL_PROCESS_OUTPUT_BYTES,
    "maxOutputBytes",
    MAX_EVAL_PROCESS_OUTPUT_BYTES
  );
  const platform = options.platform ?? process.platform;
  const spawnProcess = options.spawnProcess ?? nodeSpawn;
  const spawnControl = options.spawnControl ?? nodeSpawn;
  const kill = options.kill ?? process.kill.bind(process);
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  const stdoutState = { bytes: 0, chunks: [], truncated: false };
  const stderrState = { bytes: 0, chunks: [], truncated: false };

  let child;
  try {
    child = spawnProcess(command, args, {
      cwd: options.cwd,
      detached: platform !== "win32",
      encoding: undefined,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true
    });
  } catch {
    return {
      durationMs: Math.max(0, Math.round(now() - startedAt)),
      signal: null,
      spawnError: true,
      status: null,
      stderr: "",
      stderrTruncated: false,
      stdout: "",
      stdoutTruncated: false,
      timedOut: false
    };
  }

  child.stdout?.on("data", (chunk) => appendBounded(stdoutState, chunk, maxOutputBytes));
  child.stderr?.on("data", (chunk) => appendBounded(stderrState, chunk, maxOutputBytes));

  const closed = new Promise((resolve) => {
    let spawnError = false;
    child.once("error", () => {
      spawnError = true;
    });
    child.once("close", (status, signal) => {
      resolve({ signal, spawnError, status });
    });
  });
  // Reserve two settle windows: Windows taskkill itself is bounded by one,
  // and every platform then gets one final direct-child close window.
  const executionBudgetMs = deadlineMs - killGraceMs - (2 * FINAL_KILL_SETTLE_MS);
  let deadlineTimer;
  const executionDeadline = new Promise((resolve) => {
    deadlineTimer = setTimeout(() => resolve(undefined), executionBudgetMs);
  });
  const winner = await Promise.race([
    closed,
    executionDeadline
  ]);
  clearTimeout(deadlineTimer);

  let outcome = winner;
  let timedOut = false;
  if (winner === undefined) {
    timedOut = true;
    const pid = child.pid;
    if (typeof pid === "number" && pid > 0) {
      if (platform === "win32") {
        try {
          child.kill("SIGTERM");
        } catch {
          // Forced tree cleanup below is authoritative.
        }
      } else {
        signalOwnedPosixGroup(pid, "SIGTERM", kill);
      }
      await delay(killGraceMs);
      if (platform === "win32") {
        await forceKillWindowsTree(pid, spawnControl);
      } else {
        signalOwnedPosixGroup(pid, "SIGKILL", kill);
      }
    }
    outcome = await Promise.race([
      closed,
      delay(FINAL_KILL_SETTLE_MS).then(() => ({ signal: "SIGKILL", spawnError: false, status: null }))
    ]);
  }

  return {
    durationMs: Math.max(0, Math.round(now() - startedAt)),
    signal: outcome.signal ?? null,
    spawnError: outcome.spawnError === true,
    status: outcome.spawnError === true
      ? null
      : Number.isInteger(outcome.status) ? outcome.status : null,
    stderr: Buffer.concat(stderrState.chunks).toString("utf8"),
    stderrTruncated: stderrState.truncated,
    stdout: Buffer.concat(stdoutState.chunks).toString("utf8"),
    stdoutTruncated: stdoutState.truncated,
    timedOut
  };
}
