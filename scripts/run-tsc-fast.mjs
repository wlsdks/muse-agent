#!/usr/bin/env node
// run-tsc-fast: opinionated tsc runner for TS7-fast paths.

import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import process from "node:process";

import { getTscFastArgs } from "./tsc-fast-flags.mjs";

const [, , mode, ...flags] = process.argv;
const validModes = new Set(["build", "typecheck"]);
const singleThreaded = flags.includes("--single-threaded");

function usage() {
  console.error("usage: node scripts/run-tsc-fast.mjs <build|typecheck> [--single-threaded]");
  process.exit(64);
}

if (!validModes.has(mode)) {
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

if (typeof result.status === "number" && result.status !== 0) {
  process.exit(result.status);
}

// Support both Node versions that return null for signaled exits and old CI wrappers.
if (result.signal) {
  process.exit(1);
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  console.log(`✓ tsc-fast: completed ${mode} with ${singleThreaded ? "single-threaded" : "parallel"} flags`);
}
