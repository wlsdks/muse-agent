#!/usr/bin/env node
// TypeScript tsconfig alignment guard for TS7 performance stability.
// Keep project configs on one contract: extend tsconfig.base.json and only add
// targeted overrides that must remain stable.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

function loadJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

const BASE_PATH = "tsconfig.base.json";
const BASE_OPTIONS = loadJson(BASE_PATH).compilerOptions ?? {};

const ALLOWED_OVERRIDES = new Set([
  ...Object.keys(BASE_OPTIONS),
  "outDir",
  "rootDir",
  "tsBuildInfoFile",
  "composite",
  "types",
  "lib",
  "jsx"
]);

function collectConfigPaths() {
  const paths = ["tsconfig.json"];
  for (const scope of ["apps", "packages"]) {
    for (const entry of readdirSync(scope, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const candidate = join(scope, entry.name, "tsconfig.json");
      if (!existsSync(candidate)) {
        continue;
      }
      paths.push(candidate);
    }
  }
  return paths;
}

function isBaseAligned(extendsField) {
  return typeof extendsField === "string" && /tsconfig\.base\.json$/u.test(extendsField);
}

function isAllowedOverride(value) {
  const keys = Object.keys(value);
  return keys.filter((key) => !ALLOWED_OVERRIDES.has(key));
}

function findInvalid(baseValue, overrideValue) {
  return Object.entries(overrideValue).filter(([key, value]) => {
    return key in BASE_OPTIONS && JSON.stringify(value) !== JSON.stringify(baseValue[key]);
  }).map(([key]) => key);
}

function main() {
  const problems = [];
  const configPaths = collectConfigPaths();

  for (const configPath of configPaths) {
    const config = loadJson(configPath);
    const compilerOptions = config.compilerOptions ?? {};

    if (!isBaseAligned(config.extends)) {
      problems.push(`${configPath}: missing/invalid extends -> tsconfig.base.json`);
    }

    const unexpectedKeys = isAllowedOverride(compilerOptions);
    if (unexpectedKeys.length > 0) {
      problems.push(`${configPath}: unexpected compilerOptions overrides -> ${unexpectedKeys.join(", ")}`);
      continue;
    }

    const invalidOverrides = findInvalid(BASE_OPTIONS, compilerOptions);
    if (invalidOverrides.length > 0) {
      problems.push(`${configPath}: overrides conflict with tsconfig.base values -> ${invalidOverrides.join(", ")}`);
    }

    for (const key of ["target", "module", "moduleResolution", "skipLibCheck", "skipDefaultLibCheck"]) {
      if (compilerOptions[key] !== undefined && BASE_OPTIONS[key] !== undefined && compilerOptions[key] !== BASE_OPTIONS[key]) {
        problems.push(`${configPath}: ${key} overrides base with ${String(compilerOptions[key])} (expected ${String(BASE_OPTIONS[key])})`);
      }
    }
  }

  if (problems.length > 0) {
    console.error("✗ tsconfig alignment guard failed:");
    for (const problem of problems) {
      console.error(`  - ${problem}`);
    }
    process.exit(1);
  }

  console.log("✓ tsconfig alignment: all project configs extend base and keep option scope stable");
}

if (process.argv[1]) {
  main();
}
