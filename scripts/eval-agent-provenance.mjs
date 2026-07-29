import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  MAX_EVAL_PROCESS_DEADLINE_MS,
  MIN_EVAL_PROCESS_DEADLINE_MS,
  runBoundedEvalProcess,
} from "./eval-agent-process.mjs";

const RUNTIME_EXTENSIONS = new Set([".cjs", ".js", ".json", ".mjs", ".node", ".wasm"]);

export function defaultEvalRunnerPath(repoRoot) {
  const executable = process.platform === "win32" ? "muse-runner.exe" : "muse-runner";
  return join(repoRoot, ".muse-dev", "evals", "agent-capability", "runtime", executable);
}

export async function captureGitSourceSnapshot({
  deadlineMs = MAX_EVAL_PROCESS_DEADLINE_MS,
  now = () => performance.now(),
  remainingProcessDeadline,
  repoRoot,
  runProcess,
  sourceEnv = process.env,
  spawn,
}) {
  const execute = selectProcessRunner({ runProcess, spawn });
  const startedAt = now();
  const remainingDeadline = () => resolveRemainingDeadline({
    deadlineMs,
    now,
    remainingProcessDeadline,
    startedAt,
  });
  const env = { ...sourceEnv, GIT_OPTIONAL_LOCKS: "0" };
  const common = {
    cwd: repoRoot,
    env,
  };
  const revisionDeadline = remainingDeadline();
  if (revisionDeadline === null) return { tree: "unknown" };
  const revisionResult = await execute(
    "git",
    ["--no-optional-locks", "rev-parse", "HEAD"],
    { ...common, deadlineMs: revisionDeadline },
  );
  const revision = commandSucceeded(revisionResult) ? revisionResult.stdout.trim() : undefined;
  const treeDeadline = remainingDeadline();
  if (treeDeadline === null) {
    return { ...(revision ? { revision } : {}), tree: "unknown" };
  }
  const treeResult = await execute(
    "git",
    ["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all"],
    { ...common, deadlineMs: treeDeadline },
  );
  if (remainingDeadline() === null) {
    return { ...(revision ? { revision } : {}), tree: "unknown" };
  }
  if (!revision || !commandSucceeded(treeResult)) {
    return { ...(revision ? { revision } : {}), tree: "unknown" };
  }
  return { revision, tree: treeResult.stdout.trim().length === 0 ? "clean" : "dirty" };
}

export async function runForcedTypeScriptBuild({
  deadlineMs = MAX_EVAL_PROCESS_DEADLINE_MS,
  now = () => performance.now(),
  remainingProcessDeadline,
  repoRoot,
  runProcess,
  sourceEnv = process.env,
  spawn,
}) {
  const startedAt = now();
  try {
    const outputDirectories = validatedTypeScriptOutputDirectories(repoRoot);
    for (const outputDirectory of outputDirectories) {
      if (!existsSync(outputDirectory)) continue;
      rmSync(outputDirectory, { recursive: true });
      if (existsSync(outputDirectory)) throw new Error("typescript-output-cleanup-failed");
    }

    const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
    const execute = selectProcessRunner({ runProcess, spawn });
    const processDeadlineMs = resolveRemainingDeadline({
      deadlineMs,
      now,
      remainingProcessDeadline,
      startedAt,
    });
    if (processDeadlineMs === null) {
      return { ok: false, reason: "evaluation-deadline-exhausted" };
    }
    const result = await execute(command, ["exec", "tsc", "-b", "--force", "--pretty", "false"], {
      cwd: repoRoot,
      deadlineMs: processDeadlineMs,
      env: sourceEnv,
    });
    if (resolveRemainingDeadline({
      deadlineMs,
      now,
      remainingProcessDeadline,
      startedAt,
    }) === null) {
      return { ok: false, reason: "evaluation-deadline-exhausted" };
    }
    return commandSucceeded(result) ? { ok: true } : { ok: false, reason: "typescript-build-failed" };
  } catch {
    return { ok: false, reason: "typescript-build-failed" };
  }
}

export async function buildAndPublishRunner({
  deadlineMs = MAX_EVAL_PROCESS_DEADLINE_MS,
  now = () => performance.now(),
  remainingProcessDeadline,
  repoRoot,
  runnerPath = defaultEvalRunnerPath(repoRoot),
  runProcess,
  sourceEnv = process.env,
  spawn,
}) {
  const startedAt = now();
  const targetDir = mkdtempSync(join(tmpdir(), "muse-eval-runner-"));
  try {
    const execute = selectProcessRunner({ runProcess, spawn });
    const processDeadlineMs = resolveRemainingDeadline({
      deadlineMs,
      now,
      remainingProcessDeadline,
      startedAt,
    });
    if (processDeadlineMs === null) {
      return { ok: false, reason: "evaluation-deadline-exhausted" };
    }
    const result = await execute(
      "cargo",
      ["build", "--locked", "--manifest-path", join(repoRoot, "crates", "runner", "Cargo.toml")],
      {
        cwd: repoRoot,
        deadlineMs: processDeadlineMs,
        env: { ...sourceEnv, CARGO_TARGET_DIR: targetDir },
      },
    );
    if (resolveRemainingDeadline({
      deadlineMs,
      now,
      remainingProcessDeadline,
      startedAt,
    }) === null) {
      return { ok: false, reason: "evaluation-deadline-exhausted" };
    }
    if (!commandSucceeded(result)) {
      return { ok: false, reason: "runner-build-failed" };
    }

    const executable = process.platform === "win32" ? "muse-runner.exe" : "muse-runner";
    const builtRunner = join(targetDir, "debug", executable);
    const sourceStat = lstatSync(builtRunner);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.size === 0) {
      return { ok: false, reason: "runner-build-failed" };
    }

    let fixedRunnerPath;
    try {
      fixedRunnerPath = prepareFixedRunnerPublishDirectory(repoRoot, runnerPath);
    } catch {
      return { ok: false, reason: "runner-publish-failed" };
    }
    const publishDir = dirname(fixedRunnerPath);
    const temporary = join(publishDir, `.${basename(fixedRunnerPath)}.${randomUUID()}.tmp`);
    try {
      copyFileSync(builtRunner, temporary);
      if (process.platform !== "win32") chmodSync(temporary, 0o700);
      renameSync(temporary, fixedRunnerPath);
      if (process.platform !== "win32") chmodSync(fixedRunnerPath, 0o700);
    } catch {
      rmSync(temporary, { force: true });
      return { ok: false, reason: "runner-publish-failed" };
    }
    return { ok: true, runnerPath: fixedRunnerPath };
  } catch {
    return { ok: false, reason: "runner-build-failed" };
  } finally {
    rmSync(targetDir, { force: true, recursive: true });
  }
}

/**
 * Digest the forced TS runtime plus the one fixed runner. Only the aggregate is
 * returned; paths stay inside the hash input and never enter reports or logs.
 */
export function captureRuntimeArtifacts({ repoRoot, runnerPath = defaultEvalRunnerPath(repoRoot) }) {
  try {
    const runtimeFiles = collectTypeScriptRuntimeFiles(repoRoot);
    if (runtimeFiles.length === 0) return unknownArtifact();

    const fixedRunnerPath = validateExistingFixedRunner(repoRoot, runnerPath);
    const runnerStat = lstatSync(fixedRunnerPath);
    if (!runnerStat.isFile() || runnerStat.isSymbolicLink() || runnerStat.size === 0) {
      return unknownArtifact();
    }
    if (process.platform !== "win32" && (runnerStat.mode & 0o777) !== 0o700) {
      return unknownArtifact();
    }

    const files = [...runtimeFiles, fixedRunnerPath];
    const manifest = files
      .map((file) => {
        const contentDigest = createHash("sha256").update(readFileSync(file)).digest("hex");
        const relativePath = relative(repoRoot, file).split(sep).join("/");
        return `${relativePath}\0${contentDigest}`;
      })
      .sort();
    if (manifest.length === 0) return unknownArtifact();
    return {
      count: manifest.length,
      digest: createHash("sha256").update(manifest.join("\n")).digest("hex"),
      status: "ok",
    };
  } catch {
    return unknownArtifact();
  }
}

function collectTypeScriptRuntimeFiles(repoRoot) {
  const files = [];
  for (const outputDirectory of validatedTypeScriptOutputDirectories(repoRoot)) {
    if (!existsSync(outputDirectory)) return [];
    walkRuntimeDirectory(outputDirectory, files);
  }
  return files;
}

function validatedTypeScriptOutputDirectories(repoRoot) {
  const root = resolve(repoRoot);
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("invalid-repo-root");
  const rootRealPath = realpathSync(root);

  const configPath = join(root, "tsconfig.json");
  const configStat = lstatSync(configPath);
  if (!configStat.isFile() || configStat.isSymbolicLink()) throw new Error("invalid-root-tsconfig");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  if (!config || typeof config !== "object" || Array.isArray(config) || !Array.isArray(config.references)) {
    throw new Error("invalid-root-references");
  }
  if (config.references.length === 0) throw new Error("empty-root-references");

  const outputDirectories = [];
  const seen = new Set();
  for (const referenceEntry of config.references) {
    if (
      !referenceEntry
      || typeof referenceEntry !== "object"
      || Array.isArray(referenceEntry)
      || Object.keys(referenceEntry).length !== 1
      || typeof referenceEntry.path !== "string"
      || referenceEntry.path.length === 0
      || referenceEntry.path.trim() !== referenceEntry.path
      || referenceEntry.path.includes("\0")
      || isAbsolute(referenceEntry.path)
    ) {
      throw new Error("invalid-root-reference");
    }

    const projectDirectory = resolve(root, referenceEntry.path);
    if (!isStrictDescendant(root, projectDirectory)) throw new Error("reference-outside-repo");
    assertNoSymlinkSegments(root, projectDirectory);
    const projectRealPath = realpathSync(projectDirectory);
    if (!isStrictDescendant(rootRealPath, projectRealPath)) throw new Error("reference-outside-repo");

    const outputDirectory = join(projectDirectory, "dist");
    if (seen.has(outputDirectory)) throw new Error("duplicate-output-directory");
    seen.add(outputDirectory);
    if (existsSync(outputDirectory)) {
      assertNoSymlinkSegments(root, outputDirectory);
      const outputStat = lstatSync(outputDirectory);
      if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) throw new Error("invalid-output-directory");
      const outputRealPath = realpathSync(outputDirectory);
      if (!isStrictDescendant(rootRealPath, outputRealPath)) throw new Error("output-outside-repo");
    }
    outputDirectories.push(outputDirectory);
  }
  return outputDirectories;
}

function assertNoSymlinkSegments(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  let current = root;
  for (const segment of pathFromRoot.split(sep)) {
    if (!segment) continue;
    current = join(current, segment);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw new Error("symlinked-build-path");
  }
}

function isStrictDescendant(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot.length > 0
    && pathFromRoot !== ".."
    && !pathFromRoot.startsWith(`..${sep}`)
    && !isAbsolute(pathFromRoot);
}

function fixedRunnerLocation(repoRoot, runnerPath) {
  const root = resolve(repoRoot);
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("invalid-repo-root");
  const fixedRunnerPath = resolve(runnerPath);
  if (fixedRunnerPath !== defaultEvalRunnerPath(root)) throw new Error("noncanonical-runner-path");
  return {
    fixedRunnerPath,
    root,
    rootRealPath: realpathSync(root),
  };
}

function prepareFixedRunnerPublishDirectory(repoRoot, runnerPath) {
  const location = fixedRunnerLocation(repoRoot, runnerPath);
  const publishDirectory = dirname(location.fixedRunnerPath);
  let current = location.root;
  for (const segment of relative(location.root, publishDirectory).split(sep)) {
    if (!segment) continue;
    current = join(current, segment);
    if (!existsSync(current)) mkdirSync(current, { mode: 0o700 });
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("invalid-runner-directory");
    const currentRealPath = realpathSync(current);
    if (!isStrictDescendant(location.rootRealPath, currentRealPath)) {
      throw new Error("runner-directory-outside-repo");
    }
  }
  if (existsSync(location.fixedRunnerPath)) {
    const existing = lstatSync(location.fixedRunnerPath);
    if (!existing.isFile() || existing.isSymbolicLink()) throw new Error("invalid-existing-runner");
    if (!isStrictDescendant(location.rootRealPath, realpathSync(location.fixedRunnerPath))) {
      throw new Error("runner-outside-repo");
    }
  }
  if (process.platform !== "win32") chmodSync(publishDirectory, 0o700);
  return location.fixedRunnerPath;
}

function validateExistingFixedRunner(repoRoot, runnerPath) {
  const location = fixedRunnerLocation(repoRoot, runnerPath);
  assertNoSymlinkSegments(location.root, location.fixedRunnerPath);
  const stat = lstatSync(location.fixedRunnerPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("invalid-runner");
  if (!isStrictDescendant(location.rootRealPath, realpathSync(location.fixedRunnerPath))) {
    throw new Error("runner-outside-repo");
  }
  return location.fixedRunnerPath;
}

function walkRuntimeDirectory(directory, files) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error("artifact-symlink");
    if (stat.isDirectory()) {
      walkRuntimeDirectory(file, files);
      continue;
    }
    if (stat.isFile() && stat.size > 0 && RUNTIME_EXTENSIONS.has(extname(entry.name))) {
      files.push(file);
    }
  }
}

function commandSucceeded(result) {
  return !result?.error && !result?.signal && result?.status === 0;
}

function selectProcessRunner({ runProcess, spawn }) {
  if (typeof runProcess === "function") return runProcess;
  if (typeof spawn === "function") {
    return async (command, args, options) => spawn(command, args, options);
  }
  return runBoundedEvalProcess;
}

function boundedRemainingDeadline(totalMs, startedAt, now) {
  if (
    !Number.isSafeInteger(totalMs)
    || totalMs < MIN_EVAL_PROCESS_DEADLINE_MS
    || totalMs > MAX_EVAL_PROCESS_DEADLINE_MS
  ) {
    return null;
  }
  const elapsedMs = Math.max(0, Math.ceil(now() - startedAt));
  const remainingMs = Math.min(MAX_EVAL_PROCESS_DEADLINE_MS, totalMs - elapsedMs);
  return remainingMs >= MIN_EVAL_PROCESS_DEADLINE_MS ? remainingMs : null;
}

function resolveRemainingDeadline({
  deadlineMs,
  now,
  remainingProcessDeadline,
  startedAt,
}) {
  const localRemaining = boundedRemainingDeadline(deadlineMs, startedAt, now);
  if (localRemaining === null || typeof remainingProcessDeadline !== "function") {
    return localRemaining;
  }
  const sharedRemaining = remainingProcessDeadline();
  if (
    !Number.isSafeInteger(sharedRemaining)
    || sharedRemaining < MIN_EVAL_PROCESS_DEADLINE_MS
    || sharedRemaining > MAX_EVAL_PROCESS_DEADLINE_MS
  ) {
    return null;
  }
  return Math.min(localRemaining, sharedRemaining);
}

function unknownArtifact() {
  return { count: 0, status: "unknown" };
}
