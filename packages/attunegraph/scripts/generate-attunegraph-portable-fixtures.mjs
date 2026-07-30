import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { promisify } from "node:util";
import { basename, dirname, join, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { createAttuneGraphPortableEncoder } from "../dist/attunegraph-portable-encoder.js";

const CASES = Object.freeze([
  "empty",
  "one-scope-two-generations",
  "unicode-multi-scope"
]);
const MANIFEST_FILE = "manifest.json";
const README_FILE = "README.md";
const scriptPath = fileURLToPath(import.meta.url);
const packageRoot = resolve(dirname(scriptPath), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const checkedInRoot = resolve(packageRoot, "fixtures/portable-v1");
const executeFile = promisify(execFile);

function fail(message) {
  throw new Error(message);
}

function scopeKey(scope) {
  return JSON.stringify([scope.sourceId, scope.threadId]);
}

function compareScopes(left, right) {
  return Buffer.compare(Buffer.from(left.sourceId), Buffer.from(right.sourceId))
    || Buffer.compare(Buffer.from(left.threadId), Buffer.from(right.threadId));
}

function exactHeadSink() {
  const projections = new Map();
  const heads = new Set();
  let sealed = false;
  return {
    appendProjection(identity) {
      if (sealed) fail("projection received after seal");
      projections.set(scopeKey(identity.scope), identity);
    },
    sealProjections() {
      if (sealed) fail("projection sink sealed twice");
      sealed = true;
    },
    assertHead(head) {
      if (!sealed) fail("head received before projection seal");
      const key = scopeKey(head.scope);
      const expected = projections.get(key);
      assert.deepEqual(head, expected, "head must equal the final projection identity");
      if (heads.has(key)) fail("duplicate head");
      heads.add(key);
    },
    finish(expectedScopeCount, expectedHeadCount) {
      assert.equal(projections.size, expectedScopeCount, "scope count");
      assert.equal(heads.size, expectedHeadCount, "head count");
      assert.equal(heads.size, projections.size, "every projection scope has one head");
    },
    abort() {}
  };
}

function artifactLedger(artifact) {
  const lines = artifact.toString("utf8").slice(0, -1).split("\n");
  return lines.map((line) => {
    const record = JSON.parse(line);
    const { recordId, ...unsigned } = record;
    return {
      kind: record.kind,
      sequence: record.sequence,
      unsignedBodyBytes: Buffer.byteLength(JSON.stringify(unsigned)),
      envelopeBytes: Buffer.byteLength(line),
      lineBytes: Buffer.byteLength(line) + 1,
      recordId
    };
  });
}

function encodeCase(input, inputFile) {
  assert.deepEqual(
    Object.keys(input).sort(),
    ["case", "projections", "schemaVersion"],
    `${inputFile} fields`
  );
  assert.equal(input.schemaVersion, 1, `${inputFile}.schemaVersion`);
  if (!CASES.includes(input.case)) fail(`${inputFile}.case is unknown`);
  if (!Array.isArray(input.projections)) fail(`${inputFile}.projections must be an array`);
  const projections = [...input.projections].sort((left, right) => {
    const scopeOrder = compareScopes(left.snapshot.scope, right.snapshot.scope);
    return scopeOrder || left.snapshot.generation - right.snapshot.generation;
  });
  const sink = exactHeadSink();
  const portable = createAttuneGraphPortableEncoder({ identitySink: sink });
  const chunks = [portable.start()];
  const heads = new Map();
  for (const projection of projections) {
    const appended = portable.appendProjection(projection.snapshot.scope, projection);
    chunks.push(appended.bytes);
    heads.set(scopeKey(appended.identity.scope), appended.identity);
  }
  portable.sealProjections();
  for (const identity of [...heads.values()].sort((left, right) =>
    compareScopes(left.scope, right.scope))) {
    chunks.push(portable.appendHead(
      identity.scope,
      identity.generation,
      identity.commitId,
      identity.projectionId
    ));
  }
  const finished = portable.finish();
  chunks.push(finished.bytes);
  const artifact = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  assert.equal(artifact.byteLength, finished.report.bytes, "encoder report byte count");
  const lines = artifactLedger(artifact);
  return {
    artifact,
    manifestCase: {
      case: input.case,
      file: `${input.case}.atgx`,
      input: inputFile,
      artifactBytes: artifact.byteLength,
      artifactSha256: createHash("sha256").update(artifact).digest("hex"),
      stateId: finished.report.stateId,
      exportId: finished.report.exportId,
      scopeCount: finished.report.scopes,
      projectionCount: finished.report.projections,
      headCount: finished.report.scopes,
      recordCount: lines.length,
      lines
    }
  };
}

async function deriveCorpus(inputRoot) {
  const inputs = new Map();
  const cases = [];
  for (const caseName of CASES) {
    const inputFile = `${caseName}.input.json`;
    const bytes = await readFile(join(inputRoot, inputFile));
    if (bytes.at(-1) !== 0x0a || bytes.includes(0x0d)) {
      fail(`${inputFile} must use LF framing`);
    }
    const input = JSON.parse(bytes.toString("utf8"));
    assert.equal(input.case, caseName, `${inputFile} case/file binding`);
    inputs.set(inputFile, bytes);
    cases.push(encodeCase(input, inputFile));
  }
  return {
    inputs,
    cases,
    manifest: {
      schemaVersion: 1,
      corpus: "attunegraph-portable-fixtures",
      corpusVersion: 1,
      cases: cases.map(({ manifestCase }) => manifestCase)
    }
  };
}

async function directory(path, label, rejectSymlink = false) {
  const details = await lstat(path);
  if (!details.isDirectory()) fail(`${label} must be an existing directory`);
  if (rejectSymlink && details.isSymbolicLink()) fail(`${label} must not be a symlink`);
  return realpath(path);
}

function expectedNames() {
  return [
    README_FILE,
    MANIFEST_FILE,
    ...CASES.flatMap((caseName) => [
      `${caseName}.input.json`,
      `${caseName}.atgx`
    ])
  ].sort();
}

async function expectedFiles(sourceRoot) {
  const derived = await deriveCorpus(sourceRoot);
  const files = new Map([
    [README_FILE, await readFile(join(sourceRoot, README_FILE))],
    [MANIFEST_FILE, Buffer.from(`${JSON.stringify(derived.manifest, null, 2)}\n`)]
  ]);
  for (const [name, bytes] of derived.inputs) files.set(name, bytes);
  for (const { artifact, manifestCase } of derived.cases) {
    files.set(manifestCase.file, artifact);
  }
  return files;
}

async function checkCorpus(root) {
  const actualRoot = await directory(root, "corpus");
  assert.deepEqual((await readdir(actualRoot)).sort(), expectedNames(), "corpus file set");
  const expected = await expectedFiles(checkedInRoot);
  for (const [name, bytes] of expected) {
    assert.deepEqual(await readFile(join(actualRoot, name)), bytes, `${name} exact bytes`);
  }
  process.stdout.write(`production AttuneGraph portable fixture corpus matches: ${actualRoot}\n`);
}

async function writeFiles(outputRoot, sourceRoot) {
  const files = await expectedFiles(sourceRoot);
  for (const [name, bytes] of files) {
    await writeFile(join(outputRoot, name), bytes, { flag: "wx" });
  }
}

async function outputCorpus(outputRoot) {
  const actualOutput = await directory(outputRoot, "output", true);
  const actualRepository = await realpath(repositoryRoot);
  if (
    actualOutput === actualRepository
    || actualOutput.startsWith(`${actualRepository}${sep}`)
  ) {
    fail("repository paths are never valid output directories");
  }
  assert.deepEqual(await readdir(actualOutput), [], "output directory must be empty");
  await writeFiles(actualOutput, checkedInRoot);
  await checkCorpus(actualOutput);
}

async function verifyCleanRoom(args) {
  await executeFile(
    process.execPath,
    [resolve(packageRoot, "scripts/verify-attunegraph-portable-fixtures.mjs"), ...args],
    { cwd: packageRoot }
  );
}

const OPERATION_NAMES = Object.freeze([
  "preserve-original",
  "publish-stage",
  "quarantine-published",
  "restore-original",
  "cleanup-backup",
  "cleanup-stage"
]);

class CorpusRefreshError extends Error {
  constructor({ primary, secondary, state, targetRoot, recoveryPath, pendingCleanupPaths }) {
    const primaryMessage = primary instanceof Error ? primary.message : String(primary);
    const secondaryMessage = secondary.length === 0
      ? "none"
      : secondary.map((cause) => cause instanceof Error ? cause.message : String(cause)).join("; ");
    super(
      `AttuneGraph portable fixture refresh failed in state ${state}; `
      + `primary=${primaryMessage}; secondary=${secondaryMessage}; `
      + `target=${targetRoot}; recovery=${recoveryPath ?? "not-required"}; `
      + `pendingCleanup=${pendingCleanupPaths.join(",") || "none"}`,
      { cause: primary }
    );
    this.name = "CorpusRefreshError";
    this.state = state;
    this.targetRoot = targetRoot;
    this.recoveryPath = recoveryPath;
    this.primary = primary;
    this.secondary = Object.freeze([...secondary]);
    this.pendingCleanupPaths = Object.freeze([...pendingCleanupPaths]);
  }
}

function filesystemOperations(failOperations = []) {
  const failures = new Set(failOperations);
  for (const name of failures) {
    if (!OPERATION_NAMES.includes(name)) fail(`unknown injected filesystem operation: ${name}`);
  }
  const before = (name) => {
    if (failures.has(name)) throw new Error(`injected filesystem failure: ${name}`);
  };
  return {
    async rename(name, source, destination) {
      before(name);
      await rename(source, destination);
    },
    async remove(name, path) {
      before(name);
      await rm(path, { recursive: true, force: true });
    }
  };
}

async function refreshCorpus({
  targetRoot,
  trustedRoot,
  failOperations = [],
  failFinalVerification = false
}) {
  const actualTarget = await directory(targetRoot, "refresh target", true);
  if (actualTarget !== targetRoot) fail("refresh target path must be canonical");
  const parent = dirname(targetRoot);
  const name = basename(targetRoot);
  const stageRoot = await mkdtemp(join(parent, `.${name}.stage-`));
  const backupRoot = await mkdtemp(join(parent, `.${name}.backup-`));
  const originalRoot = join(backupRoot, "original");
  const failedRoot = join(backupRoot, "failed");
  const operations = filesystemOperations(failOperations);
  let state = "preparing";
  let stagePresent = true;
  let originalPreserved = false;
  let published = false;
  let finalVerified = false;
  const secondary = [];
  const pendingCleanupPaths = [];

  const cleanup = async (operation, path) => {
    try {
      await operations.remove(operation, path);
    } catch (cause) {
      secondary.push(cause);
      pendingCleanupPaths.push(path);
    }
  };
  const cleanupStage = async () => {
    if (!stagePresent) return;
    const failuresBefore = secondary.length;
    await cleanup("cleanup-stage", stageRoot);
    if (secondary.length === failuresBefore) stagePresent = false;
  };

  const refreshError = (primary, recoveryPath) => new CorpusRefreshError({
    primary,
    secondary,
    state,
    targetRoot,
    recoveryPath: recoveryPath ?? pendingCleanupPaths[0],
    pendingCleanupPaths
  });

  try {
    await writeFiles(stageRoot, trustedRoot);
    await verifyCleanRoom(["--check-dir", stageRoot]);
    state = "staged-verified";
    await operations.rename("preserve-original", targetRoot, originalRoot);
    originalPreserved = true;
    state = "original-preserved";
    await operations.rename("publish-stage", stageRoot, targetRoot);
    stagePresent = false;
    published = true;
    state = "published";
    if (failFinalVerification) fail("injected final verification failure");
    await verifyCleanRoom(targetRoot === checkedInRoot ? [] : ["--check-dir", targetRoot]);
    finalVerified = true;
    state = "final-verified";
    try {
      await operations.remove("cleanup-backup", backupRoot);
      originalPreserved = false;
      state = "complete";
      process.stdout.write(`refreshed and independently verified AttuneGraph portable fixtures: ${targetRoot}\n`);
      return;
    } catch (cause) {
      state = "verified-cleanup-pending";
      pendingCleanupPaths.push(backupRoot);
      throw refreshError(cause, originalRoot);
    }
  } catch (primary) {
    if (primary instanceof CorpusRefreshError) throw primary;
    if (!originalPreserved) {
      state = "pre-publish-failed";
      await cleanupStage();
      await cleanup("cleanup-backup", backupRoot);
      throw refreshError(primary, undefined);
    }
    if (finalVerified) {
      state = "verified-cleanup-pending";
      throw refreshError(primary, originalRoot);
    }

    state = "restore-started";
    if (published) {
      try {
        await operations.rename("quarantine-published", targetRoot, failedRoot);
        published = false;
        state = "published-quarantined";
      } catch (cause) {
        secondary.push(cause);
        state = "recovery-pending-target-occupied";
        throw refreshError(primary, originalRoot);
      }
    }

    try {
      await operations.rename("restore-original", originalRoot, targetRoot);
      originalPreserved = false;
      state = "original-restored";
    } catch (cause) {
      secondary.push(cause);
      state = "recovery-pending-target-absent";
      throw refreshError(primary, originalRoot);
    }

    await cleanupStage();
    await cleanup("cleanup-backup", backupRoot);
    if (secondary.length > 0) state = "restored-cleanup-pending";
    throw refreshError(primary, undefined);
  }
}

async function refreshCheckedIn() {
  const actualCheckedIn = await directory(checkedInRoot, "checked-in corpus", true);
  if (actualCheckedIn !== checkedInRoot) fail("checked-in corpus path must be canonical");
  await refreshCorpus({
    targetRoot: checkedInRoot,
    trustedRoot: checkedInRoot
  });
}

export async function refreshCorpusForTest(options) {
  const targetRoot = await realpath(resolve(options.targetRoot));
  return refreshCorpus({
    targetRoot,
    trustedRoot: checkedInRoot,
    failOperations: options.failOperations ?? [],
    failFinalVerification: options.failFinalVerification === true
  });
}

function parseMode(args) {
  if (args.length === 0 || (args.length === 1 && args[0] === "--check")) {
    return { kind: "check", directory: checkedInRoot };
  }
  if (args.length === 1 && args[0] === "--write") return { kind: "write" };
  if (
    args.length === 2
    && (args[0] === "--check-dir" || args[0] === "--output-dir")
    && typeof args[1] === "string"
    && args[1].length > 0
  ) {
    return {
      kind: args[0] === "--check-dir" ? "check" : "output",
      directory: resolve(args[1])
    };
  }
  fail(
    "usage: generate-attunegraph-portable-fixtures.mjs "
    + "[--check | --check-dir <existing-dir> | --write | "
    + "--output-dir <existing-empty-dir>]"
  );
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === scriptPath) {
  try {
    const mode = parseMode(process.argv.slice(2));
    if (mode.kind === "check") await checkCorpus(mode.directory);
    else if (mode.kind === "output") await outputCorpus(mode.directory);
    else await refreshCheckedIn();
  } catch (cause) {
    process.stderr.write(`${cause instanceof Error ? cause.stack : String(cause)}\n`);
    process.exitCode = 1;
  }
}
