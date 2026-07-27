#!/usr/bin/env node

import { createServer } from "node:http";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const host = "127.0.0.1";
const port = requiredPort(process.env.PORT);
const origin = requiredLoopbackOrigin(process.env.MUSE_PERSONAL_AGENT_EMBED_URL);
const trafficFile = requiredEnvironment("MUSE_PERSONAL_AGENT_EMBED_TRAFFIC_FILE");

if (new URL(origin).port !== port.toString()) {
  throw new Error("embedding stub PORT must match MUSE_PERSONAL_AGENT_EMBED_URL");
}

await mkdir(dirname(trafficFile), { recursive: true });

const server = createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") {
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/embeddings") {
      sendJson(response, 404, { error: "not found" });
      return;
    }

    const body = JSON.parse(await readRequestBody(request));
    if (
      body === null
      || typeof body !== "object"
      || Array.isArray(body)
      || typeof body.model !== "string"
      || body.model.trim().length === 0
      || typeof body.prompt !== "string"
      || body.prompt.trim().length === 0
    ) {
      sendJson(response, 400, { error: "model and prompt are required" });
      return;
    }

    await appendFile(trafficFile, `${JSON.stringify({
      endpoint: `${origin}/api/embeddings`,
      model: body.model,
      prompt: body.prompt
    })}\n`, "utf8");
    sendJson(response, 200, { embedding: [1, 0, 0] });
  } catch (error) {
    sendJson(response, 400, {
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

await new Promise((resolveListen, reject) => {
  server.once("error", reject);
  server.listen(port, host, resolveListen);
});

for (const [signal, exitCode] of [["SIGINT", 130], ["SIGTERM", 143]]) {
  process.once(signal, () => {
    server.close(() => process.exit(exitCode));
  });
}

function readRequestBody(request) {
  return new Promise((resolveBody, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_048_576) {
        reject(new Error("request body exceeds 1 MiB"));
        request.destroy();
      }
    });
    request.once("end", () => resolveBody(body));
    request.once("error", reject);
  });
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function requiredLoopbackOrigin(value) {
  const parsed = new URL(value ?? "");
  if (
    parsed.protocol !== "http:"
    || parsed.hostname !== "127.0.0.1"
    || !parsed.port
    || parsed.pathname !== "/"
    || parsed.search
    || parsed.hash
  ) {
    throw new Error("MUSE_PERSONAL_AGENT_EMBED_URL must be an explicit http://127.0.0.1:<port> origin");
  }
  return parsed.origin;
}

function requiredPort(value) {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError("PORT must be an integer from 1 through 65535");
  }
  return port;
}
