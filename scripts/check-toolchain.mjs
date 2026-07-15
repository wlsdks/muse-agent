#!/usr/bin/env node
// Toolchain guard: the repo builds with TypeScript 7 (the Go-native compiler)
// while every tool that imports the TypeScript MODULE keeps TypeScript 6.
//
// TS 7.0 ships no programmatic compiler API (it lands in 7.1), so
// typescript-eslint and knip — which import `typescript` directly — crash on it.
// The split is Microsoft's own side-by-side configuration, and it is
// deterministic BY CONSTRUCTION rather than by luck:
//   `typescript`         -> npm:@typescript/typescript6  (the official compat
//                           package — re-exports the 6.0 API for
//                           typescript-eslint / knip / the IDE; its binary is
//                           `tsc6`, so it can never shadow `tsc`)
//   `@typescript/native` -> npm:typescript@7  (the SOLE provider of `tsc`)
// This is the exact package.json shape the TypeScript 7.0 GA guide prescribes.
//
// Measured on this repo (3 reps each, <5% spread):
//   clean full build   8850ms -> 1325ms  (6.7x)
//   1-file rebuild      580ms ->  168ms  (3.5x)   <- the actual inner loop
//   agent-core check    480ms ->  102ms  (4.7x)
//
// The gate exists because a dependency bump could silently undo the split: a
// `typescript` that resolves to 7 would crash lint (no compiler API before 7.1),
// and a `tsc` that resolves to 6 would quietly hand back the slow build. Both are
// loud failures now.

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { getTscFastArgs, getTscFastCommand } from "./tsc-fast-flags.mjs";

export const EXPECTED_ROOT_SCRIPTS = {
  build: "pnpm run build:ts7-fast",
  typecheck: "pnpm run typecheck:ts7-fast && pnpm --filter @muse/web typecheck",
  "build:ts7-fast": getTscFastCommand("build"),
  "build:ts7-single-thread": getTscFastCommand("build", { singleThreaded: true }),
  "typecheck:fast": getTscFastCommand("typecheck"),
  "typecheck:ts7-fast": getTscFastCommand("typecheck"),
  "typecheck:ts7-single-thread": getTscFastCommand("typecheck", { singleThreaded: true }),
  check: "pnpm run check:toolchain && pnpm build && pnpm test",
};

function collectScriptProblems(scripts) {
  const problems = [];
  for (const [name, expectedValue] of Object.entries(EXPECTED_ROOT_SCRIPTS)) {
    const actualValue = scripts[name];
    if (actualValue !== expectedValue) {
      problems.push(`root script ${name} must be exactly ${JSON.stringify(expectedValue)} (got ${JSON.stringify(actualValue)})`);
    }
  }
  return problems;
}

export function collectDependencyProblems({ binVersion, moduleVersion, tsDeclaration, nativeTsDeclaration }) {
  const problems = [];
  if (parseMajor(binVersion) !== EXPECTED_BUILD_MAJOR) {
    problems.push(
      `the \`tsc\` binary is v${String(binVersion).trim()} — builds must run on the TypeScript ${EXPECTED_BUILD_MAJOR} native compiler (5-7x faster; the \`@typescript/native\` alias provides it)`
    );
  }
  if (parseMajor(moduleVersion) !== EXPECTED_MODULE_MAJOR) {
    problems.push(
      `the \`typescript\` MODULE is v${moduleVersion} — typescript-eslint and knip import it and crash on ${EXPECTED_BUILD_MAJOR}.0, which ships no compiler API (it lands in 7.1). Keep it at ${EXPECTED_MODULE_MAJOR}.`
    );
  }
  if (typeof tsDeclaration !== "string" || !tsDeclaration.startsWith(EXPECTED_TYPESCRIPT_PACKAGE_PREFIX)) {
    problems.push(
      `expected devDependency \`typescript\` to stay on ${EXPECTED_TYPESCRIPT_PACKAGE_PREFIX} for TS7 toolchain split (got ${String(tsDeclaration)})`
    );
  }
  if (typeof nativeTsDeclaration !== "string" || !nativeTsDeclaration.startsWith(EXPECTED_NATIVE_PACKAGE_PREFIX)) {
    problems.push(
      `expected devDependency \`@typescript/native\` to stay on ${EXPECTED_NATIVE_PACKAGE_PREFIX} for TS7 native compiler`
    );
  }
  return problems;
}

export function collectToolchainProblems({
  rootScripts = {},
  moduleVersion,
  tsDeclaration,
  nativeTsDeclaration,
  binVersion,
} = {}) {
  return [
    ...collectDependencyProblems({ binVersion, moduleVersion, tsDeclaration, nativeTsDeclaration }),
    ...collectScriptProblems(rootScripts),
  ];
}

export function parseMajor(version) {
  if (typeof version !== "string") {
    return Number.NaN;
  }
  const match = /^(\d+)/u.exec(version.trim());
  return match ? Number(match[1]) : Number.NaN;
}

export const EXPECTED_BUILD_MAJOR = 7;
export const EXPECTED_MODULE_MAJOR = 6;
export const EXPECTED_TYPESCRIPT_PACKAGE_PREFIX = "npm:@typescript/typescript6";
export const EXPECTED_NATIVE_PACKAGE_PREFIX = "npm:typescript";
const ROOT_PACKAGE_URL = new URL("../package.json", import.meta.url);
const TS_BINARY_PATH = "node_modules/.bin/tsc";

export function readTscBinaryVersion() {
  return execFileSync(TS_BINARY_PATH, ["--version"], { encoding: "utf8" })
    .replace(/^Version\s*/iu, "");
}

export function readRootScripts() {
  return readRootPackage().scripts ?? {};
}

export function readRootPackage() {
  const raw = readFileSync(ROOT_PACKAGE_URL, "utf8");
  return JSON.parse(raw);
}

function main() {
  const require = createRequire(import.meta.url);
  const moduleVersion = require("typescript").version;
  const packageJson = readRootPackage();
  const devDependencies = packageJson.devDependencies ?? {};
  const tsDeclaration = devDependencies.typescript;
  const nativeTsDeclaration = devDependencies["@typescript/native"];

  const binVersion = readTscBinaryVersion();

  const scripts = readRootScripts();
  const problems = collectToolchainProblems({
    rootScripts: scripts,
    binVersion,
    moduleVersion,
    tsDeclaration,
    nativeTsDeclaration,
  });

  const buildArgs = getTscFastArgs("build");
  const typecheckArgs = getTscFastArgs("typecheck");
  const buildHasNoEmit = buildArgs.includes("--noEmit");
  const typecheckHasNoEmit = typecheckArgs.includes("--noEmit");
  if (buildHasNoEmit) {
    problems.push("run-tsc-fast build mode must keep emit enabled");
  }
  if (!typecheckHasNoEmit) {
    problems.push("run-tsc-fast typecheck mode must include --noEmit");
  }

  if (problems.length > 0) {
    console.error("✗ toolchain split broken:");
    for (const problem of problems) {
      console.error(`  - ${problem}`);
    }
    process.exit(1);
  }
  console.log(`✓ toolchain: build tsc v${binVersion.trim()} (native) · typescript module v${moduleVersion} (compiler API for eslint/knip)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
