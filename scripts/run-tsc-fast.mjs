#!/usr/bin/env node
// run-tsc-fast: opinionated tsc runner for TS7-fast paths.

import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import process from "node:process";

import { getTscFastArgs, SUPPORTED_TS7_MODES } from "./tsc-fast-flags.mjs";

const USAGE = "usage: node scripts/run-tsc-fast.mjs <build|typecheck> [--single-threaded]";

export function parseRunTscFastArgs(cliArgs) {
  const [mode, ...flags] = cliArgs;
  const singleThreaded = flags.includes("--single-threaded");
  const unknownFlags = flags.filter((flag) => flag !== "--single-threaded");
  if (!mode || !SUPPORTED_TS7_MODES.has(mode)) {
    return {
      isValid: false,
      mode,
      singleThreaded: false,
      reason: !mode ? "missing mode" : "unsupported mode",
    };
  }
  if (unknownFlags.length > 0) {
    return {
      isValid: false,
      mode,
      singleThreaded,
      reason: `unsupported flag(s): ${unknownFlags.join(", ")}`,
    };
  }
  return {
    isValid: true,
    mode,
    singleThreaded
  };
}

function usage() {
  console.error(USAGE);
  process.exit(64);
}

function main() {
  const [, , ...cliArgs] = process.argv;
  const parsed = parseRunTscFastArgs(cliArgs);
  if (!parsed.isValid) {
    if (parsed.reason) {
      console.error(parsed.reason);
    }
    usage();
  }

  const { mode, singleThreaded } = parsed;
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
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
