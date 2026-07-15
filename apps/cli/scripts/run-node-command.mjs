import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 180_000;
const TIMEOUT_EXIT_CODE = 124;
const KILL_SIGNAL = "SIGKILL";

/**
 * Result from one node process invocation.
 *
 * @typedef {object} NodeCommandResult
 * @property {number} exitCode 종료 코드(타임아웃은 124).
 * @property {NodeJS.Signals | null | undefined} signal 종료 시그널.
 * @property {string} stdout 표준 출력.
 * @property {string} stderr 표준 에러.
 */

/**
 * @param {object} options
 * @param {string} options.command executable to run
 * @param {string[]} options.args arguments for the executable
 * @param {string} [options.cwd] working directory
 * @param {NodeJS.ProcessEnv} [options.env] environment map
 * @param {number} [options.timeoutMs=180000] hard timeout in milliseconds
 * @returns {Promise<NodeCommandResult>}
 */
export function runNodeCommand({ command, args, cwd, env, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    const finish = ({ exitCode, signal = null }) => {
      if (settled) return;
      settled = true;
      resolve({ exitCode, signal, stdout: stdout.trim(), stderr: stderr.trim() });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill(KILL_SIGNAL);
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      finish({ exitCode: 1, signal: error.name === "AbortError" ? "ABORT" : null });
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        finish({ exitCode: TIMEOUT_EXIT_CODE, signal });
      } else {
        finish({ exitCode: code ?? 1, signal });
      }
    });
  });
}
