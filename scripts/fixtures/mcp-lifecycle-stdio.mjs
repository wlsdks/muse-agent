#!/usr/bin/env node

import readline from "node:readline";

const lines = readline.createInterface({
  crlfDelay: Infinity,
  input: process.stdin,
  terminal: false
});

lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (!Object.hasOwn(message, "id")) return;

  let result;
  switch (message.method) {
    case "initialize":
      result = {
        capabilities: { tools: {} },
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        serverInfo: { name: "muse-cli-lifecycle-fixture", version: "1.0.0" }
      };
      break;
    case "tools/list":
      result = {
        tools: [{
          description: "Returns isolated lifecycle fixture status.",
          inputSchema: { additionalProperties: false, properties: {}, type: "object" },
          name: "lifecycle_status"
        }]
      };
      break;
    case "ping":
      result = {};
      break;
    default:
      write({
        error: { code: -32601, message: `Method not found: ${String(message.method)}` },
        id: message.id,
        jsonrpc: "2.0"
      });
      return;
  }
  write({ id: message.id, jsonrpc: "2.0", result });
});

process.once("SIGTERM", () => {
  lines.close();
  process.exit(0);
});

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
