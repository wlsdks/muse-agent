import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";

import {
  ApiSmokeStartupTimeoutError,
  ApiSmokeShutdownTimeoutError,
  createDisposableApiEnvironment,
  finishInProcessApiSmoke,
  installProcessEnvironment,
  startInProcessApi
} from "./lib/in-process-api.mjs";

test("disposable API env starts sparse and remaps every home/temp namespace", () => {
  const rootDir = join(tmpdir(), "muse-smoke-unit-root");
  const env = createDisposableApiEnvironment({
    purpose: "unit",
    rootDir,
    sourceEnv: {
      DATABASE_URL: "postgres://owner",
      HTTPS_PROXY: "https://owner-proxy",
      LANG: "ko_KR.UTF-8",
      MUSE_TELEGRAM_POLL_ENABLED: "true",
      NODE_OPTIONS: "--import ./poison.mjs",
      OPENAI_API_KEY: "owner-secret",
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://collector.example",
      PATH: "/usr/bin:/bin",
      XDG_CONFIG_HOME: "/owner/config"
    }
  });

  assert.deepEqual(Object.keys(env).sort(), [
    "APPDATA",
    "HOME",
    "LANG",
    "LOCALAPPDATA",
    "MUSE_AUTHORED_SKILLS_DIR",
    "MUSE_BELIEF_PROVENANCE_FILE",
    "MUSE_CONVERSATIONS_FILE",
    "MUSE_DAEMON_SETTINGS_FILE",
    "MUSE_LOCAL_ONLY",
    "MUSE_MESSAGING_LOG_FILE",
    "MUSE_MODEL",
    "MUSE_MODEL_PROVIDER_ID",
    "MUSE_NOTES_DIR",
    "MUSE_ORCHESTRATION_HISTORY_FILE",
    "MUSE_SKILL_REWARDS_FILE",
    "MUSE_TASKS_FILE",
    "MUSE_USER_MEMORY_AUTO_EXTRACT",
    "PATH",
    "TEMP",
    "TMP",
    "TMPDIR",
    "USERPROFILE",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME"
  ]);

  assert.equal(env.PATH, "/usr/bin:/bin");
  assert.equal(env.LANG, "ko_KR.UTF-8");
  for (const key of [
    "HOME",
    "USERPROFILE",
    "TMPDIR",
    "TMP",
    "TEMP",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "APPDATA",
    "LOCALAPPDATA"
  ]) {
    assert.ok(env[key]?.startsWith(rootDir), `${key} must be remapped under the disposable root`);
  }
  for (const forbidden of [
    "DATABASE_URL",
    "HTTPS_PROXY",
    "MUSE_TELEGRAM_POLL_ENABLED",
    "NODE_OPTIONS",
    "OPENAI_API_KEY",
    "OTEL_EXPORTER_OTLP_ENDPOINT"
  ]) {
    assert.equal(env[forbidden], undefined, `${forbidden} must not enter the application env`);
  }
  assert.equal(env.MUSE_LOCAL_ONLY, "true");
  assert.equal(env.MUSE_MODEL_PROVIDER_ID, "diagnostic");
  assert.equal(env.MUSE_USER_MEMORY_AUTO_EXTRACT, "false");
  assert.ok(env.MUSE_CONVERSATIONS_FILE?.startsWith(rootDir));
  assert.ok(env.MUSE_ORCHESTRATION_HISTORY_FILE?.startsWith(rootDir));
  assert.ok(env.MUSE_BELIEF_PROVENANCE_FILE?.startsWith(rootDir));
  assert.ok(env.MUSE_AUTHORED_SKILLS_DIR?.startsWith(rootDir));
  assert.ok(env.MUSE_DAEMON_SETTINGS_FILE?.startsWith(rootDir));
  assert.ok(env.MUSE_MESSAGING_LOG_FILE?.startsWith(rootDir));
});

test("temporary process environment replacement restores the exact prior mapping once", () => {
  const target = { OWNER_SECRET: "keep-after-restore", PATH: "/owner/bin" };
  const restore = installProcessEnvironment({ HOME: "/isolated", PATH: "/safe/bin" }, target);
  assert.deepEqual(target, { HOME: "/isolated", PATH: "/safe/bin" });
  restore();
  assert.deepEqual(target, { OWNER_SECRET: "keep-after-restore", PATH: "/owner/bin" });
  restore();
  assert.deepEqual(target, { OWNER_SECRET: "keep-after-restore", PATH: "/owner/bin" });
});

test("in-process API stop is idempotent and drains the scheduler before Fastify", async () => {
  const calls = [];
  const suppliedEnv = { HOME: "/isolated", MUSE_MODEL_PROVIDER_ID: "diagnostic" };
  const effectiveEnv = { ...suppliedEnv, MUSE_EFFECTIVE_ENV: "true" };
  let assemblyInput;
  let serverInput;
  let listenInput;
  const api = await startInProcessApi({
    env: suppliedEnv,
    loadDependencies: async () => ({
      buildServer: (input) => {
        serverInput = input;
        return {
        close: async () => { calls.push("close"); },
        listen: async (input) => {
          listenInput = input;
          calls.push("listen");
          return "http://127.0.0.1:43210";
        }
      };
      },
      createApiServerOptions: (input) => {
        assemblyInput = input;
        return {
          configuredMarker: "real-options",
          env: effectiveEnv,
          scheduler: { service: { shutdown: async () => { calls.push("drain"); return "drained"; } } }
        };
      }
    })
  });

  assert.equal(api.baseUrl, "http://127.0.0.1:43210");
  assert.strictEqual(assemblyInput.env, suppliedEnv);
  assert.strictEqual(serverInput.env, effectiveEnv);
  assert.equal(serverInput.configuredMarker, "real-options");
  assert.equal(serverInput.logger, false);
  assert.deepEqual(listenInput, { host: "127.0.0.1", port: 0 });
  await api.stop({ timeoutMs: 500 });
  await api.stop({ timeoutMs: 500 });
  assert.deepEqual(calls, ["listen", "drain", "close"]);
});

test("one deadline covers a hung scheduler and returns a typed timeout", async () => {
  const api = await startInProcessApi({
    env: { HOME: "/isolated", MUSE_MODEL_PROVIDER_ID: "diagnostic" },
    loadDependencies: async () => ({
      buildServer: () => ({
        close: async () => undefined,
        listen: async () => "http://127.0.0.1:43211"
      }),
      createApiServerOptions: ({ env }) => ({
        env,
        scheduler: { service: { shutdown: () => Promise.withResolvers().promise } }
      })
    })
  });

  await assert.rejects(
    api.stop({ timeoutMs: 25 }),
    (error) => error instanceof ApiSmokeShutdownTimeoutError
  );
});

test("startup import/assembly hangs return a typed timeout for driver-side fatal cleanup", async () => {
  await assert.rejects(
    startInProcessApi({
      env: { HOME: "/isolated", MUSE_MODEL_PROVIDER_ID: "diagnostic" },
      loadDependencies: () => Promise.withResolvers().promise,
      startupTimeoutMs: 25
    }),
    (error) => error instanceof ApiSmokeStartupTimeoutError
  );
});

test("fatal shutdown cleanup and env restore happen before explicit exit(1)", async () => {
  const calls = [];
  const result = await finishInProcessApiSmoke({
    cleanup: async () => { calls.push("cleanup"); },
    forceExit: (code) => { calls.push(`exit:${code}`); },
    restoreEnvironment: () => { calls.push("restore"); },
    stop: async () => { calls.push("stop"); throw new ApiSmokeShutdownTimeoutError(10); },
    timeoutMs: 10
  });

  assert.equal(result.exitCode, 1);
  assert.deepEqual(calls, ["stop", "cleanup", "restore", "exit:1"]);
});

test("command lifecycle exits 0 normally and exits non-zero only after timeout cleanup", async () => {
  const fixture = join(process.cwd(), "scripts", "fixtures", "in-process-api-shutdown-fixture.mjs");
  const dir = mkdtempSync(join(tmpdir(), "muse-api-shutdown-command-"));
  const marker = join(dir, "cleanup-marker.txt");
  try {
    const normal = await runFixture(fixture, "normal", marker);
    assert.equal(normal.code, 0, normal.stderr);
    assert.equal(readFileSync(marker, "utf8"), "cleanup-before-exit\n");

    rmSync(marker, { force: true });
    const hung = await runFixture(fixture, "hung", marker);
    assert.notEqual(hung.code, 0, hung.stderr);
    assert.equal(readFileSync(marker, "utf8"), "cleanup-before-exit\n");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("broad smoke uses the same in-process helper and tsx package entry", () => {
  const source = readFileSync(join(process.cwd(), "scripts", "smoke-broad-http.mjs"), "utf8");
  const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
  assert.doesNotMatch(source, /node:child_process|\bspawn\s*\(|\.kill\s*\(|waitForExit/u);
  assert.match(source, /startInProcessApi/u);
  assert.equal(manifest.scripts["smoke:broad"], "node --import tsx scripts/smoke-broad-http.mjs");
});

function runFixture(fixture, mode, marker) {
  return new Promise((resolve, reject) => {
    const env = {};
    for (const key of ["PATH", "PATHEXT", "SystemRoot", "WINDIR", "COMSPEC"]) {
      if (typeof process.env[key] === "string") env[key] = process.env[key];
    }
    const child = spawn(process.execPath, [fixture, mode, marker], {
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    const deadline = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`fixture ${mode} exceeded hard outer deadline`));
    }, 2_000);
    child.once("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(deadline);
      resolve({ code, stderr, stdout });
    });
  });
}
