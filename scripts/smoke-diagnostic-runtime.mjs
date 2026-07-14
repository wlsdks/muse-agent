#!/usr/bin/env node
import { spawn } from "node:child_process";
import net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";

const rootDir = process.cwd();
const port = await findFreePort();
const baseUrl = `http://127.0.0.1:${port}`;
const api = spawn("pnpm", ["--filter", "@muse/api", "dev"], {
  cwd: rootDir,
  env: {
    ...process.env,
    MUSE_MODEL: "diagnostic/smoke",
    MUSE_MODEL_PROVIDER_ID: "diagnostic",
    PORT: String(port)
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let apiOutput = "";
api.stdout.on("data", (chunk) => {
  apiOutput += chunk.toString();
});
api.stderr.on("data", (chunk) => {
  apiOutput += chunk.toString();
});

try {
  await waitForHealth(`${baseUrl}/health`, 20_000);
  await assertApiChat(baseUrl);
  await assertApiStream(baseUrl);
  await assertCliLocal();
  await assertCliRemote(baseUrl);
  console.log("diagnostic runtime smoke passed");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  if (apiOutput.trim().length > 0) {
    console.error("--- api output ---");
    console.error(apiOutput.trim());
  }
  process.exitCode = 1;
} finally {
  api.kill("SIGTERM");
  await waitForExit(api, 5_000);
}

async function findFreePort() {
  const ready = Promise.withResolvers();
  const server = net.createServer();
  server.unref();
  server.once("error", (cause) => ready.reject(cause instanceof Error ? cause : new Error(String(cause))));
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    server.close(() => {
      if (typeof address === "object" && address?.port) {
        ready.resolve(address.port);
        return;
      }
      ready.reject(new Error("Could not allocate a local smoke-test port"));
    });
  });
  return ready.promise;
}

async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      const body = await response.json();

      if (response.ok && body.status === "ok") {
        return;
      }
    } catch {
      // API is still starting.
    }

    await sleep(250);
  }

  throw new Error(`Timed out waiting for ${url}`);
}

async function assertApiChat(baseUrl) {
  const response = await fetch(`${baseUrl}/api/chat`, {
    body: JSON.stringify({
      message: "diagnostic api smoke",
      runId: "smoke-diagnostic-api"
    }),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
  const body = await response.json();

  assert(response.status === 200, `/api/chat expected 200, got ${response.status}`);
  assert(body.success === true, "/api/chat expected success true");
  assert(String(body.content ?? "").includes("Diagnostic response"), "/api/chat expected Diagnostic response");
}

async function assertApiStream(baseUrl) {
  const response = await fetch(`${baseUrl}/api/chat/stream`, {
    body: JSON.stringify({
      message: "diagnostic stream smoke",
      runId: "smoke-diagnostic-stream"
    }),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
  const body = await response.text();

  assert(response.status === 200, `/api/chat/stream expected 200, got ${response.status}`);
  assert(body.includes("event: message"), "/api/chat/stream expected event: message");
  assert(body.includes("event: done"), "/api/chat/stream expected event: done");
  assert(body.includes("Diagnostic response"), "/api/chat/stream expected Diagnostic response");
}

async function assertCliLocal() {
  const result = await runPnpm([
    "--filter",
    "@muse/cli",
    "dev",
    "chat",
    "--local",
    "diagnostic-cli-local",
    "--json",
    "--no-log"
  ], {
    MUSE_MODEL: "diagnostic/smoke",
    MUSE_MODEL_PROVIDER_ID: "diagnostic"
  });
  const body = parseJsonFromStdout(result.stdout);

  assert(String(body.response ?? "").includes("Diagnostic response"), "CLI local expected Diagnostic response");
}

async function assertCliRemote(baseUrl) {
  const result = await runPnpm([
    "--filter",
    "@muse/cli",
    "dev",
    "chat",
    "diagnostic-cli-remote",
    "--json",
    "--no-log",
    "--api-url",
    baseUrl
  ]);
  const body = parseJsonFromStdout(result.stdout);

  assert(String(body.content ?? "").includes("Diagnostic response"), "CLI remote expected Diagnostic response");
}

async function runPnpm(args, env = {}) {
  const result = Promise.withResolvers();
  const child = spawn("pnpm", args, {
    cwd: rootDir,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  child.on("error", (cause) => result.reject(cause instanceof Error ? cause : new Error(String(cause))));
  child.on("close", (status) => {
    if (status === 0) {
      result.resolve({ stderr, stdout });
      return;
    }
    result.reject(new Error(`pnpm ${args.join(" ")} failed with ${status}\n${stderr}\n${stdout}`));
  });
  return result.promise;
}

function parseJsonFromStdout(stdout) {
  const candidates = findJsonObjectCandidates(stdout);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && ("response" in parsed || "content" in parsed)) {
        return parsed;
      }
    } catch {
      // Keep scanning; pnpm or server logs can include unrelated JSON lines.
    }
  }

  if (candidates.length === 0) {
    throw new Error(`Could not find JSON object in stdout:\n${stdout}`);
  }

  throw new Error(`Could not parse JSON object from stdout:\n${stdout}`);
}

function findJsonObjectCandidates(text) {
  const candidates = [];

  for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let escaped = false;
    let inString = false;

    for (let index = start; index < text.length; index += 1) {
      const char = text[index];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === "\\") {
        escaped = inString;
        continue;
      }

      if (char === "\"") {
        inString = !inString;
        continue;
      }

      if (inString) {
        continue;
      }

      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
        if (depth === 0) {
          candidates.push(text.slice(start, index + 1));
          break;
        }
      }
    }
  }

  return candidates;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function waitForExit(child, timeoutMs) {
  const done = Promise.withResolvers();
  const timer = setTimeout(() => {
    child.kill("SIGKILL");
    done.resolve();
  }, timeoutMs);
  child.once("exit", () => {
    clearTimeout(timer);
    done.resolve();
  });
  return done.promise;
}
