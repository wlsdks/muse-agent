// node --test coverage for tsc-fast flag policy.
import assert from "node:assert/strict";
import test from "node:test";

import { clampProjectGraphConcurrency, resolveProjectGraphConcurrency, getTscFastBaseArgs, getTscFastArgs, TS7_PARALLELISM_ENV } from "./tsc-fast-flags.mjs";

test("clampProjectGraphConcurrency normalizes invalid and bounded values", () => {
  assert.equal(clampProjectGraphConcurrency("abc"), 1);
  assert.equal(clampProjectGraphConcurrency("-99"), 1);
  assert.equal(clampProjectGraphConcurrency("0"), 1);
  assert.equal(clampProjectGraphConcurrency("999"), 8);
  assert.equal(clampProjectGraphConcurrency("4"), 4);
  assert.equal(clampProjectGraphConcurrency("1e3"), 8);
  assert.equal(clampProjectGraphConcurrency("4.2"), 1);
});

test("TS7_PARALLELISM env overrides default concurrency", () => {
  const previous = process.env[TS7_PARALLELISM_ENV];
  process.env[TS7_PARALLELISM_ENV] = "6";
  try {
    assert.equal(resolveProjectGraphConcurrency(), 6);
  } finally {
    if (previous === undefined) {
      delete process.env[TS7_PARALLELISM_ENV];
    } else {
      process.env[TS7_PARALLELISM_ENV] = previous;
    }
  }
});

test("build mode keeps emit enabled and uses project-graph workers", () => {
  const args = getTscFastBaseArgs();
  assert.ok(args.includes("--checkers"));
  assert.ok(args.includes("--builders"));
  assert.equal(args.includes("--noEmit"), false);
});

test("typecheck mode disables emit and keeps parallel workers", () => {
  const args = getTscFastArgs("typecheck");
  assert.ok(args.includes("--checkers"));
  assert.ok(args.includes("--builders"));
  assert.equal(args.includes("--noEmit"), true);
});

test("single-threaded mode forces singleThreaded flag", () => {
  const args = getTscFastBaseArgs({ singleThreaded: true });
  assert.equal(args.includes("--singleThreaded"), true);
  assert.equal(args.includes("--checkers"), false);
  assert.equal(args.includes("--builders"), false);
});

test("getTscFastArgs rejects unknown mode", () => {
  assert.throws(
    () => {
      getTscFastArgs("invalid");
    },
    {
      name: "RangeError"
    }
  );
});
