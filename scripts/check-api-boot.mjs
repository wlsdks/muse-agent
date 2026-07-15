#!/usr/bin/env node
// Gate-runnability guard: prove the API server can BOOT at all.
//
// smoke:live / smoke:broad are the repo's live truth, but they only tell the
// truth when someone runs them — a stale `node_modules` (dep added without
// `pnpm install`) or a stale workspace `dist/` (src changed without `tsc -b`)
// kills the server at import time and the live gates silently rot until the
// next manual run. This check boots the server against the diagnostic
// provider (no LLM, no Ollama) and asserts `/health` answers — cheap enough
// for `pnpm self-eval` to run on every scoreboard entry, so gate rot becomes
// a scoreboard regression instead of a surprise.

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

export const BOOT_TIMEOUT_MS = 40_000;

/**
 * Map a dead server's output to the concrete repair the developer must run.
 * Returns undefined when the output matches no known stale-environment
 * signature (the raw output tail is printed either way).
 */
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

export function findFreePort() {
  const { promise, resolve, reject } = Promise.withResolvers();
  const srv = net.createServer();
  srv.once("error", reject);
  srv.listen(0, "127.0.0.1", () => {
    const { port } = srv.address();
    srv.close(() => {
      if (typeof port === "number") {
        resolve(port);
      } else {
        reject(new Error("Could not allocate a local API test port"));
      }
    });
  });
  return promise;
}

async function main() {
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const notesDir = mkdtempSync(join(tmpdir(), "muse-boot-notes-"));
  const storeDir = mkdtempSync(join(tmpdir(), "muse-boot-store-"));

  const api = spawn("pnpm", ["--filter", "@muse/api", "dev"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      MUSE_MODEL: "diagnostic/boot-check",
      MUSE_MODEL_PROVIDER_ID: "diagnostic",
      MUSE_NOTES_DIR: notesDir,
      MUSE_TASKS_FILE: join(storeDir, "tasks.json"),
      PORT: String(port)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  let output = "";
  api.stdout.on("data", (chunk) => (output += chunk.toString()));
  api.stderr.on("data", (chunk) => (output += chunk.toString()));
  let exited = false;
  api.on("exit", () => (exited = true));

  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let healthy = false;
  while (Date.now() < deadline && !exited) {
    try {
      const res = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1_000) });
      if (res.ok) {
        healthy = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }

  api.kill("SIGKILL");
  rmSync(notesDir, { force: true, recursive: true });
  rmSync(storeDir, { force: true, recursive: true });

  if (healthy) {
    console.log("✓ API server boots and answers /health (diagnostic provider).");
    process.exit(0);
  }
  const hint = bootFailureHint(output);
  console.error("✗ API server failed to boot — the live smoke gates CANNOT run.");
  if (hint) {
    console.error(`  Likely cause: ${hint}`);
  }
  console.error("--- api output (tail) ---");
  console.error(output.slice(-2_000));
  process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
