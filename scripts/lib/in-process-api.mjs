import { mkdirSync } from "node:fs";
import { join } from "node:path";

const PASSTHROUGH_KEYS = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ"
];

const DEFAULT_STARTUP_TIMEOUT_MS = 40_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

export class ApiSmokeStartupTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`In-process API startup exceeded ${timeoutMs.toString()}ms`);
    this.name = "ApiSmokeStartupTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

export class ApiSmokeShutdownTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`In-process API shutdown exceeded ${timeoutMs.toString()}ms`);
    this.name = "ApiSmokeShutdownTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Build the complete environment visible to an in-process API smoke run.
 * It intentionally starts empty: ambient database, telemetry, proxy, cloud
 * provider, and daemon activation settings do not cross this boundary.
 */
export function createDisposableApiEnvironment({ purpose, rootDir, sourceEnv = process.env }) {
  if (typeof rootDir !== "string" || rootDir.trim().length === 0) {
    throw new TypeError("rootDir must be a non-empty disposable directory path");
  }
  const label = typeof purpose === "string" && purpose.trim().length > 0
    ? purpose.trim().replace(/[^a-z0-9_-]+/giu, "-").slice(0, 48)
    : "smoke";
  const home = join(rootDir, "home");
  const temp = join(rootDir, "tmp");
  const stores = join(rootDir, "stores");
  const env = {};

  for (const key of PASSTHROUGH_KEYS) {
    const value = environmentValue(sourceEnv, key);
    if (value !== undefined) {
      env[key] = value;
    }
  }

  Object.assign(env, {
    APPDATA: join(rootDir, "windows", "appdata"),
    HOME: home,
    LOCALAPPDATA: join(rootDir, "windows", "local-appdata"),
    MUSE_BELIEF_PROVENANCE_FILE: join(stores, "belief-provenance.json"),
    MUSE_AUTHORED_SKILLS_DIR: join(stores, "skills", "authored"),
    MUSE_CONVERSATIONS_FILE: join(stores, "conversations.json"),
    MUSE_DAEMON_SETTINGS_FILE: join(stores, "daemon-settings.json"),
    MUSE_LOCAL_ONLY: "true",
    MUSE_MESSAGING_LOG_FILE: join(stores, "notifications.log"),
    MUSE_MODEL: `diagnostic/${label}`,
    MUSE_MODEL_PROVIDER_ID: "diagnostic",
    MUSE_NOTES_DIR: join(stores, "notes"),
    MUSE_ORCHESTRATION_HISTORY_FILE: join(stores, "orchestration-history.json"),
    MUSE_SKILL_REWARDS_FILE: join(stores, "skill-rewards.json"),
    MUSE_TASKS_FILE: join(stores, "tasks.json"),
    MUSE_USER_MEMORY_AUTO_EXTRACT: "false",
    TEMP: temp,
    TMP: temp,
    TMPDIR: temp,
    USERPROFILE: home,
    XDG_CACHE_HOME: join(rootDir, "xdg", "cache"),
    XDG_CONFIG_HOME: join(rootDir, "xdg", "config"),
    XDG_DATA_HOME: join(rootDir, "xdg", "data"),
    XDG_STATE_HOME: join(rootDir, "xdg", "state")
  });
  return env;
}

export function ensureDisposableApiDirectories(env) {
  const directories = new Set([
    env.HOME,
    env.USERPROFILE,
    env.TMPDIR,
    env.TMP,
    env.TEMP,
    env.XDG_CONFIG_HOME,
    env.XDG_CACHE_HOME,
    env.XDG_DATA_HOME,
    env.XDG_STATE_HOME,
    env.APPDATA,
    env.LOCALAPPDATA,
    env.MUSE_NOTES_DIR
  ]);
  for (const directory of directories) {
    if (typeof directory === "string" && directory.length > 0) {
      mkdirSync(directory, { recursive: true });
    }
  }
}

/** Replace a process-like environment object and return an idempotent restore. */
export function installProcessEnvironment(nextEnvironment, targetEnvironment = process.env) {
  const previous = { ...targetEnvironment };
  replaceEnvironment(targetEnvironment, nextEnvironment);
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    replaceEnvironment(targetEnvironment, previous);
  };
}

/**
 * Start the real API composition without crossing a process boundary.
 * Muse modules are dynamically imported so callers can install the sparse
 * process environment before any application module evaluates.
 */
export async function startInProcessApi({
  env,
  host = "127.0.0.1",
  loadDependencies = loadRealDependencies,
  logger = false,
  port = 0,
  startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS
}) {
  requirePositiveTimeout(startupTimeoutMs, "startupTimeoutMs");
  const start = async () => {
    const { buildServer, createApiServerOptions } = await loadDependencies();
    const options = createApiServerOptions({ env });
    const effectiveEnv = options.env ?? env;
    const server = buildServer({ ...options, env: effectiveEnv, logger });
    let baseUrl;
    try {
      baseUrl = await server.listen({ host, port });
    } catch (error) {
      await bestEffortStartupClose(options, server);
      throw error;
    }

    let stopPromise;
    const stop = ({ timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS } = {}) => {
      requirePositiveTimeout(timeoutMs, "timeoutMs");
      stopPromise ??= withDeadline(
        shutdownApi(options, server, timeoutMs),
        timeoutMs,
        () => new ApiSmokeShutdownTimeoutError(timeoutMs)
      );
      return stopPromise;
    };
    return { baseUrl: baseUrl.replace(/\/$/u, ""), options, server, stop };
  };

  return withDeadline(start(), startupTimeoutMs, () => new ApiSmokeStartupTimeoutError(startupTimeoutMs));
}

/**
 * Close, clean, and restore in the only safe order. A failed close may leave
 * live handles, so force-exit happens only after both cleanup attempts.
 */
export async function finishInProcessApiSmoke({
  cleanup,
  exitCode = 0,
  forceExit = (code) => process.exit(code),
  restoreEnvironment,
  stop,
  timeoutMs = DEFAULT_SHUTDOWN_TIMEOUT_MS
}) {
  let finalExitCode = exitCode === 0 ? 0 : 1;
  let shutdownError;
  const cleanupErrors = [];

  if (stop) {
    try {
      await stop({ timeoutMs });
    } catch (error) {
      shutdownError = error;
      finalExitCode = 1;
    }
  }
  try {
    await cleanup();
  } catch (error) {
    cleanupErrors.push(error);
    finalExitCode = 1;
  }
  try {
    await restoreEnvironment();
  } catch (error) {
    cleanupErrors.push(error);
    finalExitCode = 1;
  }

  if (shutdownError !== undefined) {
    forceExit(1);
  }
  return { cleanupErrors, exitCode: finalExitCode, shutdownError };
}

async function loadRealDependencies() {
  const [{ createApiServerOptions }, { buildServer }] = await Promise.all([
    import("../../packages/autoconfigure/src/index.ts"),
    import("../../apps/api/src/server.ts")
  ]);
  return { buildServer, createApiServerOptions };
}

async function shutdownApi(options, server, timeoutMs) {
  let firstError;
  try {
    const result = await options.scheduler?.service?.shutdown(timeoutMs);
    if (result === "timeout") {
      firstError = new ApiSmokeShutdownTimeoutError(timeoutMs);
    }
  } catch (error) {
    firstError = error;
  }
  try {
    await server.close();
  } catch (error) {
    firstError ??= error;
  }
  if (firstError !== undefined) {
    throw firstError;
  }
}

async function bestEffortStartupClose(options, server) {
  try {
    options.scheduler?.service?.destroy();
  } catch {
    // The original startup error remains authoritative.
  }
  try {
    await server.close();
  } catch {
    // The original startup error remains authoritative.
  }
}

function withDeadline(operation, timeoutMs, errorFactory) {
  let deadline;
  const timeout = new Promise((_, reject) => {
    deadline = setTimeout(() => reject(errorFactory()), timeoutMs);
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(deadline));
}

function replaceEnvironment(target, source) {
  for (const key of Object.keys(target)) {
    delete target[key];
  }
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string") {
      target[key] = value;
    }
  }
}

function environmentValue(source, key) {
  if (typeof source[key] === "string") return source[key];
  const found = Object.keys(source).find((candidate) => candidate.toLowerCase() === key.toLowerCase());
  return found && typeof source[found] === "string" ? source[found] : undefined;
}

function requirePositiveTimeout(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}
