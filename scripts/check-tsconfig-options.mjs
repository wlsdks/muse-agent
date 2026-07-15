#!/usr/bin/env node
// TypeScript tsconfig alignment guard for TS7 performance stability.
// Keep project configs on one contract: extend tsconfig.base.json and only add
// targeted overrides that must remain stable.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_PATH = "tsconfig.base.json";
const DEFAULT_TARGET = /tsconfig\.base\.json$/u;

function loadJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

const BASE_OPTIONS = loadJson(ROOT_PATH).compilerOptions ?? {};

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
  return paths.sort();
}

function isBaseAligned(extendsField) {
  return typeof extendsField === "string" && DEFAULT_TARGET.test(extendsField);
}

function findDisallowedCompilerOptions(value) {
  const keys = Object.keys(value);
  return keys.filter((key) => !ALLOWED_OVERRIDES.has(key));
}

function findBaseConflictKeys(baseValue, overrideValue) {
  return Object.entries(overrideValue).filter(([key, value]) => {
    if (key === "types") {
      return false;
    }
    return key in BASE_OPTIONS && JSON.stringify(value) !== JSON.stringify(baseValue[key]);
  }).map(([key]) => key);
}

function findMissingBaseTypes(baseValue, overrideValue) {
  if (!Array.isArray(baseValue)) {
    return [];
  }
  if (overrideValue === undefined) {
    return [];
  }
  const overrideSet = new Set(Array.isArray(overrideValue) ? overrideValue : []);
  return baseValue.filter((entry) => !overrideSet.has(entry));
}

export function collectTsconfigProblems(config, compilerOptions) {
  const problems = [];
  if (!isBaseAligned(config.extends)) {
    problems.push(`missing/invalid extends -> tsconfig.base.json`);
  }
  const unexpectedKeys = findDisallowedCompilerOptions(compilerOptions);
  if (unexpectedKeys.length > 0) {
    problems.push(`unexpected compilerOptions overrides -> ${unexpectedKeys.join(", ")}`);
    return problems;
  }

  const invalidOverrides = findBaseConflictKeys(BASE_OPTIONS, compilerOptions);
  if (invalidOverrides.length > 0) {
    problems.push(`overrides conflict with base values -> ${invalidOverrides.join(", ")}`);
  }

  const missingTypes = findMissingBaseTypes(BASE_OPTIONS.types, compilerOptions.types);
  if (missingTypes.length > 0) {
    problems.push(`types override dropped base entries -> ${missingTypes.join(", ")}`);
  }

  for (const key of ["target", "module", "moduleDetection", "moduleResolution", "skipLibCheck", "skipDefaultLibCheck"]) {
    if (compilerOptions[key] !== undefined && BASE_OPTIONS[key] !== undefined && compilerOptions[key] !== BASE_OPTIONS[key]) {
      problems.push(`overrides ${key} with ${String(compilerOptions[key])} (expected ${String(BASE_OPTIONS[key])})`);
    }
  }
  return problems;
}

export function collectAllTsconfigProblems() {
  const problems = {};
  const configPaths = collectConfigPaths();

  for (const configPath of configPaths) {
    const config = loadJson(configPath);
    const compilerOptions = config.compilerOptions ?? {};
    const localProblems = collectTsconfigProblems(config, compilerOptions);
    if (localProblems.length > 0) {
      problems[configPath] = localProblems;
    }
  }
  return problems;
}

function main() {
  const flatProblems = collectAllTsconfigProblems();
  const flattenedEntries = formatTsconfigProblems(flatProblems);

  if (flattenedEntries.length > 0) {
    console.error("✗ tsconfig alignment guard failed:");
    for (const problem of flattenedEntries) {
      console.error(`  - ${problem}`);
    }
    process.exit(1);
  }

  console.log("✓ tsconfig alignment: all project configs extend base and keep option scope stable");
}

export {
  collectConfigPaths,
  isBaseAligned,
  findDisallowedCompilerOptions,
  findBaseConflictKeys,
  findMissingBaseTypes,
  collectTsconfigProblems,
  collectAllTsconfigProblems,
  formatTsconfigProblems
};

export function formatTsconfigProblems(problemByConfig) {
  const entries = Object.entries(problemByConfig).sort(([left], [right]) => left.localeCompare(right, "en", { sensitivity: "base" }));
  return entries.flatMap(([configPath, issues]) =>
    issues.map((issue) => `${configPath}: ${issue}`)
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
