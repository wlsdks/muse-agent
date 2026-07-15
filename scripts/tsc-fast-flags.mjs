#!/usr/bin/env node
// Shared concurrency and argument policy for TS7-fast project builds/typechecks.
// The goal is to keep a single source of truth for performance-related flags.

import { availableParallelism } from "node:os";

const MIN_PROJECT_GRAPH_WORKERS = 1;
const MAX_PROJECT_GRAPH_WORKERS = 8;
const TS7_PARALLELISM_ENV = "TS7_PARALLELISM";

export function clampProjectGraphConcurrency(rawValue, { min = MIN_PROJECT_GRAPH_WORKERS, max = MAX_PROJECT_GRAPH_WORKERS } = {}) {
  const parsed = Number.parseInt(String(rawValue), 10);
  if (Number.isNaN(parsed)) {
    return min;
  }
  return Math.min(max, Math.max(min, parsed));
}

export function resolveProjectGraphConcurrency() {
  const cpus = availableParallelism();
  const envValue = process.env[TS7_PARALLELISM_ENV];
  const defaultValue = Math.min(Math.max(MIN_PROJECT_GRAPH_WORKERS, cpus), MAX_PROJECT_GRAPH_WORKERS);
  return envValue === undefined ? defaultValue : clampProjectGraphConcurrency(envValue);
}

export function getTscFastBaseArgs({ singleThreaded = false, noEmit = false } = {}) {
  const args = ["-b", "--incremental", "--pretty", "false"];
  if (singleThreaded) {
    args.push("--singleThreaded");
  } else {
    const concurrency = resolveProjectGraphConcurrency();
    args.push("--checkers", String(concurrency), "--builders", String(concurrency));
  }
  if (noEmit) {
    args.push("--noEmit");
  }
  return args;
}

export function getTscFastArgs(mode, options = {}) {
  if (mode === "typecheck") {
    return getTscFastBaseArgs({ ...options, noEmit: true });
  }
  return getTscFastBaseArgs(options);
}
