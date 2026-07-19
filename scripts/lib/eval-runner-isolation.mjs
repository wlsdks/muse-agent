import { existsSync } from "node:fs";

import { createRustRunnerTool } from "../../packages/tools/dist/index.js";

/**
 * Strict runner isolation is currently implemented by macOS Seatbelt. Live
 * coding evals must report an explicit environmental skip when it cannot be
 * enforced; they must never fall back to an unsandboxed command.
 */
export function resolveEvalRunnerIsolationSkip({
  platform = process.platform,
  sandboxExecExists = existsSync("/usr/bin/sandbox-exec")
} = {}) {
  if (platform !== "darwin") {
    return { code: "sandbox-missing", message: "strict runner isolation requires macOS Seatbelt" };
  }
  if (!sandboxExecExists) {
    return { code: "sandbox-missing", message: "strict runner isolation requires /usr/bin/sandbox-exec" };
  }
  return undefined;
}

/**
 * Model-visible run_command bound to one disposable eval fixture. The trusted
 * caller supplies the root; it is not part of the tool input schema.
 */
export function createEvalRunnerTool({ fixtureRoot, invokeRunner, runnerPath }) {
  return createRustRunnerTool({
    isolationRoot: fixtureRoot,
    ...(invokeRunner ? { invokeRunner } : {}),
    ...(runnerPath ? { runnerPath } : {})
  });
}
