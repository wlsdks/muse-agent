// node --test coverage for the toolchain-guard helper.
import assert from "node:assert/strict";
import test from "node:test";

import {
  EXPECTED_BUILD_MAJOR,
  EXPECTED_MODULE_MAJOR,
  EXPECTED_NATIVE_PACKAGE_PREFIX,
  EXPECTED_TYPESCRIPT_PACKAGE_PREFIX,
  EXPECTED_ROOT_SCRIPTS,
  readRootPackage,
  parseMajor,
  collectToolchainProblems,
  readRootScripts
} from "./check-toolchain.mjs";
import { getTscFastArgs, getTscFastCommand } from "./tsc-fast-flags.mjs";

test("parseMajor reads the major from tsc's version output and from a semver", () => {
  assert.equal(parseMajor("7.0.2"), 7);
  assert.equal(parseMajor("  6.0.3 "), 6);
  assert.equal(parseMajor("7.0.2-beta"), 7);
  assert.equal(parseMajor("7"), 7);
});

test("parseMajor yields NaN on garbage rather than a wrong number", () => {
  assert.ok(Number.isNaN(parseMajor("not-a-version")));
  assert.ok(Number.isNaN(parseMajor(undefined)));
});

test("check-toolchain policy requires TS7 split dependency selectors", () => {
  const packageJson = readRootPackage();
  const devDependencies = packageJson.devDependencies ?? {};
  const typescriptSelector = devDependencies.typescript;
  const nativeSelector = devDependencies["@typescript/native"];

  assert.equal(typeof typescriptSelector, "string");
  assert.equal(typescriptSelector.startsWith(EXPECTED_TYPESCRIPT_PACKAGE_PREFIX), true);
  assert.equal(typeof nativeSelector, "string");
  assert.equal(nativeSelector.startsWith(EXPECTED_NATIVE_PACKAGE_PREFIX), true);
});

test("the split is build-on-7, module-on-6 (TS7 ships no compiler API until 7.1)", () => {
  assert.equal(EXPECTED_BUILD_MAJOR, 7);
  assert.equal(EXPECTED_MODULE_MAJOR, 6);
});

test("root scripts keep TS7-fast build/typecheck paths", () => {
  const scripts = readRootScripts();
  for (const [name, expectedValue] of Object.entries(EXPECTED_ROOT_SCRIPTS)) {
    assert.equal(scripts[name], expectedValue);
  }
  assert.equal(scripts["typecheck:fast"], getTscFastCommand("typecheck"));
  assert.equal(scripts["typecheck:ts7-single-thread"], getTscFastCommand("typecheck", { singleThreaded: true }));
  assert.equal(scripts["build:ts7-single-thread"], getTscFastCommand("build", { singleThreaded: true }));
});

test("collectToolchainProblems reports missing script entries without false positives", () => {
  const scripts = { ...readRootScripts() };
  scripts.build = "wrong";
  const packageJson = readRootPackage();
  const devDependencies = packageJson.devDependencies ?? {};
  const problems = collectToolchainProblems({
    rootScripts: scripts,
    binVersion: "7.0.2",
    moduleVersion: "6.0.2",
    tsDeclaration: devDependencies.typescript,
    nativeTsDeclaration: devDependencies["@typescript/native"],
  });
  assert.equal(problems.some((p) => p.includes("root script build")), true);
});

test("ts7-fast scripts use the shared runner contract", () => {
  const scripts = readRootScripts();
  assert.equal(scripts["build:ts7-fast"], getTscFastCommand("build"));
  assert.equal(scripts["typecheck:ts7-fast"], getTscFastCommand("typecheck"));
  assert.equal(getTscFastArgs("build").includes("--noEmit"), false);
  assert.equal(getTscFastArgs("typecheck").includes("--noEmit"), true);
});
