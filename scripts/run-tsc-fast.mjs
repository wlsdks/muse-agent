#!/usr/bin/env node
// run-tsc-fast: opinionated tsc runner for TS7-fast paths.

import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import process from "node:process";

import { getTscFastArgs, SUPPORTED_TS7_MODES } from "./tsc-fast-flags.mjs";

const [, , ...cliArgs] = process.argv;
const [mode, ...flags] = cliArgs;
const singleThreaded = flags.includes("--single-threaded");
const unknownFlags = flags.filter((flag) => flag !== "--single-threaded");

function usage() {
  console.error("usage: node scripts/run-tsc-fast.mjs <build|typecheck> [--single-threaded]");
  process.exit(64);
}

if (!mode || !SUPPORTED_TS7_MODES.has(mode)) {
  usage();
}
if (unknownFlags.length > 0) {
  console.error(`unsupported flag(s): ${unknownFlags.join(", ")}`);
  usage();
}

const args = getTscFastArgs(mode, { singleThreaded });
const result = spawnSync("node_modules/.bin/tsc", args, {
  stdio: "inherit",
});

if (result.error) {
  console.error("✗ tsc-fast runner failed:", result.error.message);
  process.exit(1);
}

if (result.signal) {
  console.error("✗ tsc-fast runner stopped by signal:", result.signal);
  process.exit(1);
}

if (typeof result.status === "number" && result.status !== 0) {
  process.exit(result.status);
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(`✓ tsc-fast: completed ${mode} with ${singleThreaded ? "single-threaded" : "parallel"} flags`);
}
