import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const verifier = join(scriptDirectory, "verify-app-metadata.mjs");
const repositoryRoot = resolve(scriptDirectory, "../../..");
const rootVersion = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8")).version;
const expectedBuild = "7001";

function escapeXml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function plistEntry(key, value) {
  if (value?.type === "integer") {
    return `  <key>${key}</key><integer>${value.value}</integer>`;
  }
  return `  <key>${key}</key><string>${escapeXml(value)}</string>`;
}

function createBundle(metadata = {}) {
  const directory = mkdtempSync(join(tmpdir(), "muse-metadata-"));
  const bundle = join(directory, "Muse.app");
  const contents = join(bundle, "Contents");
  mkdirSync(contents, { recursive: true });
  const fields = {
    CFBundleShortVersionString: rootVersion,
    CFBundleVersion: expectedBuild,
    LSMinimumSystemVersion: "14.0",
    ...metadata,
  };
  const entries = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => plistEntry(key, value))
    .join("\n");
  writeFileSync(
    join(contents, "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0">\n<dict>\n${entries}\n</dict>\n</plist>\n`,
  );
  return { bundle, directory };
}

function runVerifier(args, env = {}) {
  return spawnSync(process.execPath, [verifier, ...args], {
    encoding: "utf8",
    env: { ...process.env, MUSE_DESKTOP_BUILD_NUMBER: expectedBuild, ...env },
  });
}

function expectFailure(metadata, messagePattern) {
  const { bundle, directory } = createBundle(metadata);
  try {
    const result = runVerifier([bundle]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, messagePattern);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("metadata fields derive from current source and allow a validated CI build override", () => {
  assert.equal(runVerifier(["--field", "version"]).stdout.trim(), rootVersion);
  assert.equal(runVerifier(["--field", "minimum-system-version"]).stdout.trim(), "14.0");
  assert.equal(runVerifier(["--field", "build-number"]).stdout.trim(), expectedBuild);

  const defaultEnvironment = { ...process.env };
  delete defaultEnvironment.MUSE_DESKTOP_BUILD_NUMBER;
  const defaultBuild = spawnSync(process.execPath, [verifier, "--field", "build-number"], {
    encoding: "utf8",
    env: defaultEnvironment,
  });
  const gitCount = spawnSync("git", ["-C", repositoryRoot, "rev-list", "--count", "HEAD"], { encoding: "utf8" });
  assert.equal(defaultBuild.status, 0, defaultBuild.stderr);
  assert.equal(defaultBuild.stdout.trim(), gitCount.stdout.trim());

  const invalidOverride = runVerifier(["--field", "build-number"], { MUSE_DESKTOP_BUILD_NUMBER: "0" });
  assert.notEqual(invalidOverride.status, 0);
  assert.match(invalidOverride.stderr, /positive decimal integer/);
});

test("current synthetic bundle passes", () => {
  const { bundle, directory } = createBundle();
  try {
    const result = runVerifier([bundle]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`version ${rootVersion.replaceAll(".", "\\.")}, build ${expectedBuild}, macOS 14\\.0`));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("stale version fails closed", () => {
  expectFailure({ CFBundleShortVersionString: "0.1.0" }, /must equal root version/);
});

test("whitespace-padded version fails closed", () => {
  expectFailure({ CFBundleShortVersionString: ` ${rootVersion} ` }, /must equal root version/);
});

test("nonpositive and nonnumeric build numbers fail closed", async (context) => {
  for (const value of ["0", "not-a-number"]) {
    await context.test(value, () => {
      expectFailure({ CFBundleVersion: value }, /positive decimal integer/);
    });
  }
});

test("positive but stale build number fails closed", () => {
  expectFailure({ CFBundleVersion: "7000" }, /must equal current build number 7001/);
});

test("whitespace-padded build number fails closed", () => {
  expectFailure({ CFBundleVersion: ` ${expectedBuild} ` }, /positive decimal integer/);
});

test("integer-typed build number fails closed", () => {
  expectFailure({ CFBundleVersion: { type: "integer", value: 7001 } }, /CFBundleVersion must be a string/);
});

test("wrong minimum system version fails closed", () => {
  expectFailure({ LSMinimumSystemVersion: "13.0" }, /LSMinimumSystemVersion must equal 14\.0/);
});

test("whitespace-padded minimum system version fails closed", () => {
  expectFailure({ LSMinimumSystemVersion: " 14.0 " }, /LSMinimumSystemVersion must equal 14\.0/);
});

test("missing required key fails closed", () => {
  expectFailure({ CFBundleVersion: undefined }, /Info.plist is missing CFBundleVersion/);
});
