#!/usr/bin/env node
/**
 * Call ONE registered tool with a JSON argument object and print what the MODEL
 * would see. Investigation harness for the runtime seam the definition audit
 * never touched: a tool's answer to a bad argument is what decides whether the
 * model recovers in one step, retries blindly, or reports a wrong answer as
 * fact.
 *
 * Usage: node scripts/probe-tool-runtime.mjs <toolName> '<jsonArgs>'
 */

import process from "node:process";

const [, , name, rawArgs = "{}"] = process.argv;
if (!name) {
  console.error("usage: probe-tool-runtime.mjs <toolName> '<jsonArgs>'");
  process.exit(2);
}

const { createMuseRuntimeAssembly } = await import("../packages/autoconfigure/dist/index.js");
const registry = createMuseRuntimeAssembly({ env: { ...process.env } }).toolRegistry;
const tool = registry.list().find((entry) => entry.definition.name === name);
if (!tool) {
  console.log(JSON.stringify({ error: `tool '${name}' is not registered in this environment`, notRegistered: true }));
  process.exit(0);
}

// Refuse to execute anything that can change state. This harness exists to
// study answers, not to perform actions on the owner's real machine.
if (tool.definition.risk !== "read") {
  console.log(JSON.stringify({ refused: `'${name}' is risk=${tool.definition.risk}; this probe only runs read-risk tools` }));
  process.exit(0);
}

let args;
try {
  args = JSON.parse(rawArgs);
} catch (cause) {
  console.error(`args must be JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
  process.exit(2);
}

const started = Date.now();
let result;
let threw = false;
try {
  result = await tool.execute(args, { runId: "probe", userId: "stark" });
} catch (cause) {
  threw = true;
  result = { message: cause instanceof Error ? cause.message : String(cause) };
}
const serialized = JSON.stringify(result ?? null);

console.log(JSON.stringify({
  approxTokens: Math.round(serialized.length / 4),
  bytes: serialized.length,
  elapsedMs: Date.now() - started,
  // A THROW is a distinct failure mode from a returned {error}: it aborts the
  // turn instead of giving the model something to act on.
  threw,
  result: serialized.length > 4000 ? `${serialized.slice(0, 4000)}…[truncated]` : result
}, null, 1));
