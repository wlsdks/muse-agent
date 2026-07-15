// node --test coverage for run-tsc-fast argument parsing.
import assert from "node:assert/strict";
import test from "node:test";

import { isTscFastProfilingEnabled, parseRunTscFastArgs } from "./run-tsc-fast.mjs";

test("parseRunTscFastArgs accepts build and typecheck", () => {
  const parsedBuild = parseRunTscFastArgs(["build"]);
  assert.equal(parsedBuild.isValid, true);
  assert.equal(parsedBuild.mode, "build");
  assert.equal(parsedBuild.singleThreaded, false);

  const parsedTypecheck = parseRunTscFastArgs(["typecheck", "--single-threaded"]);
  assert.equal(parsedTypecheck.isValid, true);
  assert.equal(parsedTypecheck.mode, "typecheck");
  assert.equal(parsedTypecheck.singleThreaded, true);
});

test("parseRunTscFastArgs rejects missing or unsupported modes", () => {
  const parsedNoMode = parseRunTscFastArgs([]);
  assert.equal(parsedNoMode.isValid, false);
  assert.equal(parsedNoMode.reason, "missing mode");

  const parsedUnknownMode = parseRunTscFastArgs(["watch"]);
  assert.equal(parsedUnknownMode.isValid, false);
  assert.equal(parsedUnknownMode.reason, "unsupported mode");
});

test("parseRunTscFastArgs rejects unsupported flags", () => {
  const parsedUnknownFlag = parseRunTscFastArgs(["build", "--bad"]);
  assert.equal(parsedUnknownFlag.isValid, false);
  assert.equal(parsedUnknownFlag.reason, "unsupported flag(s): --bad");
});

test("isTscFastProfilingEnabled parses environment values", () => {
  assert.equal(isTscFastProfilingEnabled(undefined), false);
  assert.equal(isTscFastProfilingEnabled(""), false);
  assert.equal(isTscFastProfilingEnabled("0"), false);
  assert.equal(isTscFastProfilingEnabled("1"), true);
  assert.equal(isTscFastProfilingEnabled("true"), true);
  assert.equal(isTscFastProfilingEnabled("YES"), true);
  assert.equal(isTscFastProfilingEnabled(" off "), false);
  assert.equal(isTscFastProfilingEnabled("on"), true);
});
