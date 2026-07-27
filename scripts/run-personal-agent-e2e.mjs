#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createDisposableApiEnvironment,
  ensureDisposableApiDirectories
} from "./lib/in-process-api.mjs";
import {
  bindOwnedProcessGroup,
  forceOwnedProcessGroup,
  OwnedProcessGroupStillRunningError,
  ownedProcessGroupMembers,
  signalOwnedProcessRoot,
  waitForOwnedProcessGroupExit
} from "./lib/owned-process-group.mjs";
import { installOwnedResourceSignalHandlers } from "./lib/owned-resource-signals.mjs";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const artifactDir = join(
  rootDir,
  ".muse-dev",
  "evals",
  "personal-agent-roadmap",
  "task-046-c",
  "playwright"
);

export function createPersonalAgentE2eEnvironment({
  apiPort,
  browserExecutable,
  embedPort,
  sourceEnv,
  stateRoot,
  webPort
}) {
  requirePort(apiPort, "apiPort");
  requirePort(embedPort, "embedPort");
  requirePort(webPort, "webPort");
  if (new Set([apiPort, embedPort, webPort]).size !== 3) {
    throw new RangeError("API, embedding, and web ports must differ");
  }
  const root = resolveNonEmptyPath(stateRoot, "stateRoot");
  const executable = resolveNonEmptyPath(browserExecutable, "browserExecutable");
  const env = createDisposableApiEnvironment({
    purpose: "personal-agent-e2e",
    rootDir: root,
    sourceEnv
  });
  const webUrl = `http://127.0.0.1:${webPort.toString()}`;
  const embedUrl = `http://127.0.0.1:${embedPort.toString()}`;
  Object.assign(env, {
    CI: "1",
    MUSE_CORS_ALLOWED_ORIGINS: webUrl,
    MUSE_EMBED_MODEL: "personal-agent-fixture-embed",
    MUSE_PERSONAL_AGENT_API_URL: `http://127.0.0.1:${apiPort.toString()}`,
    MUSE_PERSONAL_AGENT_ARTIFACT_DIR: artifactDir,
    MUSE_PERSONAL_AGENT_BROWSER_EXECUTABLE: executable,
    MUSE_PERSONAL_AGENT_EMBED_TRAFFIC_FILE: join(root, "embedding-traffic.jsonl"),
    MUSE_PERSONAL_AGENT_EMBED_URL: embedUrl,
    MUSE_PERSONAL_AGENT_STATE_ROOT: root,
    MUSE_PERSONAL_AGENT_WEB_URL: webUrl,
    MUSE_NOTES_INDEX_FILE: join(root, "stores", "notes-index.json"),
    OLLAMA_BASE_URL: embedUrl
  });
  return env;
}

async function main() {
  const stateRoot = await mkdtemp(join(tmpdir(), "muse-personal-agent-e2e-"));
  const diagnosticsEnabled = process.env.MUSE_PERSONAL_AGENT_E2E_LIFECYCLE_DIAGNOSTICS === "1";
  const forceFailure = process.env.MUSE_PERSONAL_AGENT_E2E_FORCE_FAILURE === "1";
  let owned;
  let cleanupPromise;
  const cleanup = () => {
    cleanupPromise ??= (async () => {
      if (owned !== undefined) await stopOwnedProcessGroup(owned.receipt);
      await rm(stateRoot, { force: true, recursive: true });
    })();
    return cleanupPromise;
  };
  const uninstallSignalHandlers = installOwnedResourceSignalHandlers({
    close: cleanup,
    onCleanupError: (error) => {
      process.stderr.write(`personal-agent E2E signal cleanup failed: ${errorMessage(error)}\n`);
    }
  });

  let primaryError;
  try {
    const [apiPort, embedPort, webPort, browserExecutable] = await Promise.all([
      reserveLoopbackPort(),
      reserveLoopbackPort(),
      reserveLoopbackPort(),
      resolveChromiumExecutable()
    ]);
    const env = createPersonalAgentE2eEnvironment({
      apiPort,
      browserExecutable,
      embedPort,
      sourceEnv: process.env,
      stateRoot,
      webPort
    });
    ensureDisposableApiDirectories(env);
    await mkdir(artifactDir, { recursive: true });
    const playwrightArgs = [
      "--filter",
      "@muse/web",
      "exec",
      "playwright",
      "test",
      "--config",
      "playwright.personal-agent.config.ts"
    ];
    if (forceFailure) {
      playwrightArgs.push("--grep", "__muse_forced_no_match__");
    }
    owned = await spawnOwned(
      "pnpm",
      playwrightArgs,
      env
    );
    if (diagnosticsEnabled) {
      process.stdout.write(`${JSON.stringify({
        apiUrl: env.MUSE_PERSONAL_AGENT_API_URL,
        embedUrl: env.MUSE_PERSONAL_AGENT_EMBED_URL,
        stateRoot,
        type: "personal-agent-e2e-owned-state",
        webUrl: env.MUSE_PERSONAL_AGENT_WEB_URL
      })}\n`);
    }
    const terminal = await withTimeout(
      owned.terminal,
      180_000,
      "personal-agent Playwright run exceeded 180000ms"
    );
    if (terminal.signal !== null || terminal.code !== 0) {
      throw new Error(
        `personal-agent Playwright exited code=${String(terminal.code)} signal=${String(terminal.signal)}`
      );
    }
  } catch (error) {
    primaryError = error;
  } finally {
    uninstallSignalHandlers();
    try {
      await cleanup();
    } catch (cleanupError) {
      primaryError = primaryError === undefined
        ? cleanupError
        : new AggregateError([primaryError, cleanupError], "personal-agent E2E and cleanup both failed");
    }
  }
  if (primaryError !== undefined) throw primaryError;
  process.stdout.write("personal-agent E2E fixture PASS (local-only, persisted, residue 0)\n");
}

async function spawnOwned(command, args, env) {
  const child = spawn(command, args, {
    cwd: rootDir,
    detached: true,
    env,
    stdio: "inherit"
  });
  const terminal = new Promise((resolveTerminal) => {
    child.once("close", (code, signal) => resolveTerminal({ code, signal }));
  });
  try {
    return {
      child,
      receipt: await bindOwnedProcessGroup(child.pid),
      terminal
    };
  } catch (error) {
    child.kill("SIGTERM");
    await withTimeout(terminal, 2_000, "unbound Playwright child did not exit").catch(() => {
      child.kill("SIGKILL");
    });
    throw error;
  }
}

async function stopOwnedProcessGroup(receipt) {
  const members = await ownedProcessGroupMembers(receipt);
  if (members.length === 0) return;
  await signalOwnedProcessRoot(receipt, "SIGTERM");
  try {
    await waitForOwnedProcessGroupExit(receipt, { timeoutMs: 5_000 });
  } catch (error) {
    if (!(error instanceof OwnedProcessGroupStillRunningError)) throw error;
    await forceOwnedProcessGroup(receipt, "SIGKILL", { memberReceipts: members });
    await waitForOwnedProcessGroupExit(receipt, { timeoutMs: 5_000 });
  }
}

async function reserveLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    server.close();
    throw new Error("loopback port reservation did not return an address");
  }
  await new Promise((resolveClose, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolveClose();
    });
  });
  return address.port;
}

async function resolveChromiumExecutable() {
  const playwright = await import(
    new URL("../apps/web/node_modules/@playwright/test/index.js", import.meta.url)
  );
  const chromium = playwright.chromium
    ?? playwright.default?.chromium
    ?? playwright["module.exports"]?.chromium;
  if (chromium === undefined) {
    throw new Error("@playwright/test did not expose chromium");
  }
  return chromium.executablePath();
}

function requirePort(value, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new RangeError(`${name} must be an integer from 1 through 65535`);
  }
}

function resolveNonEmptyPath(value, name) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty path`);
  }
  return resolve(value);
}

function withTimeout(operation, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer));
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
