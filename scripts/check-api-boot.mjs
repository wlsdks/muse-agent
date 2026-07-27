#!/usr/bin/env node
// Gate-runnability guard: prove the real API composition can boot without
// creating a subprocess tree or touching the owner's ~/.muse state.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  ApiSmokeStartupTimeoutError,
  createDisposableApiEnvironment,
  ensureDisposableApiDirectories,
  finishInProcessApiSmoke,
  installProcessEnvironment,
  startInProcessApi
} from "./lib/in-process-api.mjs";

export const BOOT_TIMEOUT_MS = 40_000;

/** Map a boot failure to the concrete repair a developer should try. */
export function bootFailureHint(output) {
  if (/ERR_MODULE_NOT_FOUND|Cannot find package/u.test(output)) {
    return "stale node_modules — a workspace dependency was added without installing. Run: pnpm install";
  }
  if (/does not provide an export named/u.test(output)) {
    return "stale workspace dist/ — a package's src changed without rebuilding. Run: pnpm --filter @muse/api build";
  }
  if (/EADDRINUSE/u.test(output)) {
    return "port collision — another server holds the probe port; re-run.";
  }
  return undefined;
}

async function main() {
  const disposableRoot = mkdtempSync(join(tmpdir(), "muse-api-boot-"));
  const env = createDisposableApiEnvironment({
    purpose: "boot-check",
    rootDir: disposableRoot,
    sourceEnv: process.env
  });
  ensureDisposableApiDirectories(env);
  const restoreEnvironment = installProcessEnvironment(env);
  let api;
  let failure;
  let forceExitRequested = false;
  let healthy = false;

  try {
    api = await startInProcessApi({ env, startupTimeoutMs: BOOT_TIMEOUT_MS });
    const [livenessResponse, readinessResponse] = await Promise.all([
      fetch(`${api.baseUrl}/health`, { signal: AbortSignal.timeout(1_000) }),
      fetch(`${api.baseUrl}/ready`, { signal: AbortSignal.timeout(1_000) })
    ]);
    const [livenessBody, readinessBody] = await Promise.all([
      livenessResponse.json(),
      readinessResponse.json()
    ]);
    if (
      !livenessResponse.ok
      || livenessBody.status !== "ok"
      || livenessBody.liveness?.status !== "up"
    ) {
      throw new Error(
        `liveness probe returned HTTP ${livenessResponse.status.toString()}: ${JSON.stringify(livenessBody)}`
      );
    }
    if (!readinessResponse.ok || readinessBody.readiness?.status !== "ready") {
      throw new Error(
        `readiness probe returned HTTP ${readinessResponse.status.toString()}: ${JSON.stringify(readinessBody)}`
      );
    }
    healthy = true;
  } catch (error) {
    failure = error;
  } finally {
    const finished = await finishInProcessApiSmoke({
      cleanup: () => rmSync(disposableRoot, { force: true, maxRetries: 3, recursive: true, retryDelay: 100 }),
      exitCode: healthy ? 0 : 1,
      forceExit: () => { forceExitRequested = true; },
      restoreEnvironment,
      stop: api?.stop,
      timeoutMs: 10_000
    });
    failure ??= finished.shutdownError ?? finished.cleanupErrors[0];
    if (finished.exitCode !== 0) healthy = false;
  }

  if (healthy) {
    console.log("✓ API server boots in-process with /health up and /ready ready (diagnostic provider).");
    return;
  }

  const output = failure instanceof Error ? (failure.stack ?? failure.message) : String(failure ?? "unknown failure");
  const hint = bootFailureHint(output);
  console.error("✗ API server failed to boot — the live smoke gates CANNOT run.");
  if (hint) console.error(`  Likely cause: ${hint}`);
  console.error("--- api failure ---");
  console.error(output.slice(-2_000));
  if (forceExitRequested || failure instanceof ApiSmokeStartupTimeoutError) {
    process.exit(1);
  }
  process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
