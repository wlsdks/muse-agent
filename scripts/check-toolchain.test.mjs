// node --test coverage for the toolchain-guard helper.
import assert from "node:assert/strict";
import test from "node:test";

import { EXPECTED_BUILD_MAJOR, EXPECTED_MODULE_MAJOR, hasConcurrentProjectGraphFlags, hasNoEmitFlag, parseMajor, readRootScripts } from "./check-toolchain.mjs";

test("parseMajor reads the major from tsc's version output and from a semver", () => {
  assert.equal(parseMajor("7.0.2"), 7);
  assert.equal(parseMajor("  6.0.3 "), 6);
  assert.equal(parseMajor("7.0.2-beta"), 7);
});

test("parseMajor yields NaN on garbage rather than a wrong number", () => {
  assert.ok(Number.isNaN(parseMajor("not-a-version")));
});

test("the split is build-on-7, module-on-6 (TS7 ships no compiler API until 7.1)", () => {
  assert.equal(EXPECTED_BUILD_MAJOR, 7);
  assert.equal(EXPECTED_MODULE_MAJOR, 6);
});

test("root scripts keep TS7-fast build/typecheck paths", () => {
  const scripts = readRootScripts();
  assert.equal(scripts.build, "pnpm run build:ts7-fast");
  assert.equal(scripts.typecheck, "pnpm run typecheck:ts7-fast && pnpm --filter @muse/web typecheck");
});

test("ts7-fast scripts declare checkers/builders concurrency flags", () => {
  const scripts = readRootScripts();
  assert.equal(hasConcurrentProjectGraphFlags(scripts["build:ts7-fast"] ?? ""), true);
  assert.equal(hasConcurrentProjectGraphFlags(scripts["typecheck:ts7-fast"] ?? ""), true);
  assert.equal(hasNoEmitFlag(scripts["typecheck:ts7-fast"] ?? ""), true);
});
