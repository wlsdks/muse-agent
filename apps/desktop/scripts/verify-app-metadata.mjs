#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../../..");
const stableSemverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const positiveIntegerPattern = /^[1-9]\d*$/;

function fail(message) {
  process.stderr.write(`desktop release metadata verification failed: ${message}\n`);
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) {
    fail(`${command} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`;
    fail(`${command} failed: ${detail}`);
  }
  return result.stdout;
}

function releaseVersion() {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
  } catch (error) {
    fail(`cannot read root package.json: ${error.message}`);
  }

  if (typeof manifest.version !== "string" || !stableSemverPattern.test(manifest.version)) {
    fail("root package.json version must be a stable MAJOR.MINOR.PATCH release version");
  }
  return manifest.version;
}

function buildNumber() {
  const override = process.env.MUSE_DESKTOP_BUILD_NUMBER;
  const value = override === undefined
    ? run("git", ["-C", repositoryRoot, "rev-list", "--count", "HEAD"]).trim()
    : override;

  if (!positiveIntegerPattern.test(value)) {
    fail("MUSE_DESKTOP_BUILD_NUMBER or git revision count must be a positive decimal integer");
  }
  return value;
}

function validatedMinimumSystemVersion() {
  const packageManifest = readFileSync(join(repositoryRoot, "apps/desktop/Package.swift"), "utf8");
  const platform = packageManifest.match(/platforms:\s*\[\s*\.macOS\(\.v(\d+)\)\s*\]/);
  if (platform?.[1] !== "14") {
    fail("Package.swift must declare macOS 14 before packaging LSMinimumSystemVersion 14.0");
  }
  return `${platform[1]}.0`;
}

function readPlist(plistPath) {
  run("/usr/bin/plutil", ["-lint", plistPath]);
  const json = run("/usr/bin/plutil", ["-convert", "json", "-o", "-", plistPath]);
  let plist;
  try {
    plist = JSON.parse(json);
  } catch (error) {
    fail(`Info.plist could not be decoded: ${error.message}`);
  }
  if (plist === null || Array.isArray(plist) || typeof plist !== "object") {
    fail("Info.plist root must be a dictionary");
  }
  return plist;
}

function plistString(plist, key) {
  if (!Object.hasOwn(plist, key)) {
    fail(`Info.plist is missing ${key}`);
  }
  if (typeof plist[key] !== "string") {
    fail(`${key} must be a string`);
  }
  return plist[key];
}

function verifyBundle(bundlePath) {
  const plistPath = join(resolve(bundlePath), "Contents/Info.plist");
  const plist = readPlist(plistPath);

  const actualVersion = plistString(plist, "CFBundleShortVersionString");
  const expectedVersion = releaseVersion();
  if (!stableSemverPattern.test(actualVersion) || actualVersion !== expectedVersion) {
    fail(`CFBundleShortVersionString must equal root version ${expectedVersion}; received ${actualVersion || "empty"}`);
  }

  const actualBuild = plistString(plist, "CFBundleVersion");
  if (!positiveIntegerPattern.test(actualBuild)) {
    fail(`CFBundleVersion must be a positive decimal integer; received ${actualBuild || "empty"}`);
  }
  const expectedBuild = buildNumber();
  if (actualBuild !== expectedBuild) {
    fail(`CFBundleVersion must equal current build number ${expectedBuild}; received ${actualBuild}`);
  }

  const actualMinimum = plistString(plist, "LSMinimumSystemVersion");
  const expectedMinimum = validatedMinimumSystemVersion();
  if (actualMinimum !== expectedMinimum) {
    fail(`LSMinimumSystemVersion must equal ${expectedMinimum}; received ${actualMinimum || "empty"}`);
  }

  process.stdout.write(`verified desktop release metadata: version ${expectedVersion}, build ${expectedBuild}, macOS ${expectedMinimum}\n`);
}

const args = process.argv.slice(2);
if (args[0] === "--field") {
  const fields = {
    version: releaseVersion,
    "build-number": buildNumber,
    "minimum-system-version": validatedMinimumSystemVersion,
  };
  const readField = fields[args[1]];
  if (!readField || args.length !== 2) {
    fail("--field requires version, build-number, or minimum-system-version");
  }
  process.stdout.write(`${readField()}\n`);
} else if (args.length === 1) {
  verifyBundle(args[0]);
} else {
  fail("usage: verify-app-metadata.mjs <bundle.app> | --field <name>");
}
