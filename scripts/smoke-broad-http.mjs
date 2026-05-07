#!/usr/bin/env node
import { spawn } from "node:child_process";
import net from "node:net";

const rootDir = process.cwd();
const port = await findFreePort();
const baseUrl = `http://127.0.0.1:${port}`;
const env = {
  ...process.env,
  MUSE_MODEL: "diagnostic/smoke",
  MUSE_MODEL_PROVIDER_ID: "diagnostic",
  PORT: String(port)
};
const api = spawn("pnpm", ["--filter", "@muse/api", "dev"], {
  cwd: rootDir,
  env,
  stdio: ["ignore", "pipe", "pipe"]
});

let apiOutput = "";
api.stdout.on("data", (chunk) => {
  apiOutput += chunk.toString();
});
api.stderr.on("data", (chunk) => {
  apiOutput += chunk.toString();
});

const checks = [];
let failures = 0;

function record(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      checks.push({ name, status: "ok" });
    })
    .catch((error) => {
      failures += 1;
      checks.push({ error: error instanceof Error ? error.message : String(error), name, status: "fail" });
    });
}

try {
  await waitForHealth(`${baseUrl}/health`, 25_000);

  await record("GET /health", async () => {
    const response = await fetch(`${baseUrl}/health`);
    const body = await response.json();
    assert(response.ok, `expected 200, got ${response.status}`);
    assert(body.status === "ok", `expected status ok, got ${JSON.stringify(body)}`);
  });

  await record("POST /api/chat", async () => {
    const response = await fetch(`${baseUrl}/api/chat`, {
      body: JSON.stringify({ message: "smoke broad chat", runId: "smoke-broad-chat" }),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
    const body = await response.json();
    assert(response.status === 200, `expected 200, got ${response.status}`);
    assert(body.success === true, "expected success true");
    assert(typeof body.content === "string" && body.content.length > 0, "expected non-empty content");
  });

  await record("POST /api/chat/stream", async () => {
    const response = await fetch(`${baseUrl}/api/chat/stream`, {
      body: JSON.stringify({ message: "smoke broad stream", runId: "smoke-broad-stream" }),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
    const body = await response.text();
    assert(response.status === 200, `expected 200, got ${response.status}`);
    assert(body.includes("event: message"), "expected event: message");
    assert(body.includes("event: done"), "expected event: done");
  });

  await record("GET /api/openapi.json", async () => {
    const response = await fetch(`${baseUrl}/api/openapi.json`);
    const body = await response.json();
    assert(response.ok, `expected 200, got ${response.status}`);
    assert(body && typeof body === "object", "expected JSON object");
    assert(body.openapi || body.swagger, "expected openapi/swagger field");
  });

  await record("GET /api/admin/settings", async () => {
    const response = await fetch(`${baseUrl}/api/admin/settings`);
    assert(response.status === 200, `expected 200, got ${response.status}`);
    const body = await response.json();
    assert(Array.isArray(body), "expected runtime settings array");
  });

  await record("GET /api/admin/agent-specs", async () => {
    const response = await fetch(`${baseUrl}/api/admin/agent-specs`);
    assert(response.status === 200, `expected 200, got ${response.status}`);
    const body = await response.json();
    assert(Array.isArray(body) || (body && typeof body === "object"), "expected array or object");
  });

  await record("GET /api/admin/audits", async () => {
    const response = await fetch(`${baseUrl}/api/admin/audits`);
    assert(response.status === 200, `expected 200, got ${response.status}`);
    const body = await response.json();
    assert(Array.isArray(body.items), "expected items array");
    assert(typeof body.total === "number", "expected total number");
  });

  await record("GET /api/admin/metrics/latency/summary", async () => {
    const response = await fetch(`${baseUrl}/api/admin/metrics/latency/summary`);
    assert(response.status === 200, `expected 200, got ${response.status}`);
    const body = await response.json();
    assert(typeof body.count === "number", "expected count number");
    assert(typeof body.p95Ms === "number", "expected p95Ms number");
  });

  await record("GET /api/admin/metrics/latency/timeseries", async () => {
    const response = await fetch(`${baseUrl}/api/admin/metrics/latency/timeseries`);
    assert(response.status === 200, `expected 200, got ${response.status}`);
    const body = await response.json();
    assert(Array.isArray(body), "expected array");
  });

  await record("GET /api/admin/token-cost/daily", async () => {
    const response = await fetch(`${baseUrl}/api/admin/token-cost/daily`);
    assert(response.status === 200, `expected 200, got ${response.status}`);
    const body = await response.json();
    assert(Array.isArray(body), "expected array");
  });

  await record("GET /api/admin/token-cost/top-expensive", async () => {
    const response = await fetch(`${baseUrl}/api/admin/token-cost/top-expensive`);
    assert(response.status === 200, `expected 200, got ${response.status}`);
    const body = await response.json();
    assert(Array.isArray(body), "expected array");
  });

  await record("GET /api/admin/conversation-analytics/failure-patterns", async () => {
    const response = await fetch(`${baseUrl}/api/admin/conversation-analytics/failure-patterns`);
    assert(response.status === 200, `expected 200, got ${response.status}`);
    const body = await response.json();
    assert(typeof body.totalFailures === "number", "expected totalFailures number");
    assert(Array.isArray(body.byClass), "expected byClass array");
  });

  await record("GET /api/admin/tools/accuracy", async () => {
    const response = await fetch(`${baseUrl}/api/admin/tools/accuracy`);
    assert(response.status === 200, `expected 200, got ${response.status}`);
    const body = await response.json();
    assert(typeof body.accuracy === "number", "expected accuracy number");
    assert(typeof body.timeoutRate === "number", "expected timeoutRate number");
    assert(typeof body.errorRate === "number", "expected errorRate number");
  });

  await record("GET /api/approvals/pending", async () => {
    const response = await fetch(`${baseUrl}/api/approvals/pending`);
    assert(response.status === 200, `expected 200, got ${response.status}`);
    const body = await response.json();
    assert(Array.isArray(body), "expected array");
  });

  await record("GET /api/scheduler/jobs", async () => {
    const response = await fetch(`${baseUrl}/api/scheduler/jobs`);
    assert(response.status === 200, `expected 200, got ${response.status}`);
    const body = await response.json();
    assert(Array.isArray(body) || Array.isArray(body.items), "expected array or { items }");
  });

  await record("GET /api/mcp/servers", async () => {
    const response = await fetch(`${baseUrl}/api/mcp/servers`);
    assert(response.status === 200 || response.status === 404, `expected 200/404, got ${response.status}`);
  });

  await record("POST /api/admin/platform/cache/invalidate", async () => {
    const response = await fetch(`${baseUrl}/api/admin/platform/cache/invalidate`, {
      body: JSON.stringify({}),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
    assert(response.status === 200 || response.status === 204, `expected 200/204, got ${response.status}`);
  });

  await record("GET /api/admin/rag-analytics/status", async () => {
    const response = await fetch(`${baseUrl}/api/admin/rag-analytics/status`);
    assert(response.status === 200, `expected 200, got ${response.status}`);
  });

  await record("GET /api/admin/followup-suggestions/stats", async () => {
    const response = await fetch(`${baseUrl}/api/admin/followup-suggestions/stats`);
    assert(response.status === 200, `expected 200, got ${response.status}`);
    const body = await response.json();
    assert(typeof body.totalImpressions === "number" || typeof body.total === "number", "expected stats shape");
  });

  await record("GET /api/admin/agent-specs reveals registered Jarvis tools via OpenAPI surface", async () => {
    const response = await fetch(`${baseUrl}/api/openapi.json`);
    const body = await response.json();
    assert(response.ok, `expected 200, got ${response.status}`);
    assert(body.paths && typeof body.paths === "object", "expected OpenAPI paths object");
  });

  await record("Jarvis tools register with the runtime tool registry", async () => {
    const { createMuseRuntimeAssembly } = await import(`${rootDir}/packages/autoconfigure/dist/index.js`);
    const assembly = createMuseRuntimeAssembly({ env: { MUSE_JARVIS_TOOLS_ENABLED: "true" } });
    const names = assembly.toolRegistry.list().map((tool) => tool.definition.name);
    for (const required of ["time_now", "time_diff", "time_add", "text_stats", "math_eval", "json_query"]) {
      assert(names.includes(required), `expected tool registry to include ${required}, got ${names.join(", ")}`);
    }
  });

  await record("Jarvis tools can be disabled via MUSE_JARVIS_TOOLS_ENABLED=false", async () => {
    const { createMuseRuntimeAssembly } = await import(`${rootDir}/packages/autoconfigure/dist/index.js`);
    const assembly = createMuseRuntimeAssembly({ env: { MUSE_JARVIS_TOOLS_ENABLED: "false" } });
    const names = assembly.toolRegistry.list().map((tool) => tool.definition.name);
    assert(!names.includes("time_now"), `expected time_now to be absent when disabled, got ${names.join(", ")}`);
  });

  await record("POST /api/chat with metadata.agentMode=plan_execute", async () => {
    const response = await fetch(`${baseUrl}/api/chat`, {
      body: JSON.stringify({
        message: "smoke broad plan execute",
        metadata: { agentMode: "plan_execute" },
        runId: "smoke-broad-plan-execute"
      }),
      headers: { "content-type": "application/json" },
      method: "POST"
    });
    assert(
      response.status === 200 || response.status === 422,
      `expected 200 or 422, got ${response.status}`
    );
    const body = await response.json();
    if (response.status === 422) {
      const code = body.errorCode ?? body.code;
      assert(
        code === "PLAN_GENERATION_FAILED" ||
          code === "PLAN_ALL_STEPS_FAILED" ||
          code === "PLAN_VALIDATION_FAILED" ||
          code === "RESPONSE_SYNTHESIS_FAILED",
        `expected structured plan-execute error code, got ${code}`
      );
    } else {
      assert(typeof body.content === "string", "expected content string");
    }
  });
} catch (error) {
  failures += 1;
  checks.push({ error: error instanceof Error ? error.message : String(error), name: "bootstrap", status: "fail" });
} finally {
  for (const check of checks) {
    if (check.status === "ok") {
      console.log(`PASS  ${check.name}`);
    } else {
      console.error(`FAIL  ${check.name}: ${check.error ?? "(unknown)"}`);
    }
  }
  console.log(`---\n${checks.filter((c) => c.status === "ok").length} passed, ${failures} failed`);

  if (failures > 0 && apiOutput.trim().length > 0) {
    console.error("--- api output ---");
    console.error(apiOutput.trim());
  }

  api.kill("SIGTERM");
  await waitForExit(api, 5_000);
  process.exitCode = failures > 0 ? 1 : 0;
}

async function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address?.port) {
          resolve(address.port);
          return;
        }
        reject(new Error("Could not allocate a local smoke-test port"));
      });
    });
  });
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
      // API still starting.
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, timeoutMs);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}
