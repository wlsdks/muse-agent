// node --test coverage for scripts/githooks/pre-push's stage logic: the
// fail-CLOSED compile gate (PATH stripped of pnpm -> BLOCK, never skip) and
// the two escape-hatch env vars. Runs the real hook script as a bash
// subprocess against a throwaway temp git repo with a logging `pnpm` shim on
// PATH — never a real push, never a real pnpm build.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const prePushScript = path.join(here, "githooks", "pre-push");
const realGitDir = path.dirname(execFileSync("which", ["git"], { encoding: "utf8" }).trim());

function makeTempRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-prepush-test-"));
  execFileSync("git", ["init", "--quiet"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Muse Test"], { cwd: dir });
  return dir;
}

function makePnpmShim(logFile, exitCode) {
  const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-prepush-shim-"));
  const shimPath = path.join(shimDir, "pnpm");
  fs.writeFileSync(
    shimPath,
    `#!/usr/bin/env bash\necho "$@" >> "${logFile}"\nexit ${exitCode}\n`,
    { mode: 0o755 }
  );
  return shimDir;
}

function runHook(repoDir, { pathDirs, env = {}, input }) {
  return spawnSync("bash", [prePushScript], {
    cwd: repoDir,
    env: {
      PATH: pathDirs.join(":"),
      HOME: env.HOME ?? fs.mkdtempSync(path.join(os.tmpdir(), "muse-prepush-home-")),
      ...env
    },
    input,
    encoding: "utf8"
  });
}

function writeAndCommit(repoDir, relPath, contents, message) {
  const full = path.join(repoDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
  execFileSync("git", ["add", relPath], { cwd: repoDir });
  execFileSync("git", ["commit", "--quiet", "-m", message], { cwd: repoDir });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" }).trim();
}

function refUpdateStdin(localSha, remoteSha) {
  return `refs/heads/main ${localSha} refs/heads/main ${remoteSha}\n`;
}

test("fail-CLOSED: pnpm missing from PATH blocks the push (never silently skips)", () => {
  const repoDir = makeTempRepo();
  const result = runHook(repoDir, { pathDirs: [realGitDir, "/usr/bin", "/bin"] });

  assert.notEqual(result.status, 0, "must exit nonzero — a missing pnpm blocks, it does not skip");
  assert.match(result.stderr, /BLOCKED/u);
  assert.match(result.stderr, /pnpm not found/u);
});

test("compile gate runs and grounding is skipped under MUSE_SKIP_PREPUSH=1", () => {
  const repoDir = makeTempRepo();
  const logFile = path.join(repoDir, "pnpm.log");
  const shimDir = makePnpmShim(logFile, 0);

  const result = runHook(repoDir, {
    pathDirs: [shimDir, realGitDir, "/usr/bin", "/bin"],
    env: { MUSE_SKIP_PREPUSH: "1" }
  });

  assert.equal(result.status, 0, result.stderr);
  const calls = fs.readFileSync(logFile, "utf8").trim().split("\n");
  assert.ok(calls.some((c) => c.includes("typecheck:fast")), "typecheck:fast must have run");
  assert.ok(calls.some((c) => c.includes("@muse/web")), "the apps/web tsc check must have run");
  assert.ok(!calls.some((c) => c.includes("precheck:grounding")), "stage 3 (grounding) must be skipped — MUSE_SKIP_PREPUSH only skips stage 3");
  assert.match(result.stderr, /grounding tripwire skipped \(MUSE_SKIP_PREPUSH=1\)/u);
});

test("all three pnpm stages run when nothing is skipped", () => {
  const repoDir = makeTempRepo();
  const logFile = path.join(repoDir, "pnpm.log");
  const shimDir = makePnpmShim(logFile, 0);

  const result = runHook(repoDir, { pathDirs: [shimDir, realGitDir, "/usr/bin", "/bin"] });

  assert.equal(result.status, 0, result.stderr);
  const calls = fs.readFileSync(logFile, "utf8").trim().split("\n");
  assert.equal(calls.length, 3);
  assert.ok(calls[0].includes("typecheck:fast"));
  assert.ok(calls[1].includes("@muse/web"));
  assert.ok(calls[2].includes("precheck:grounding"));
});

test("a failing compile-gate stage blocks before the grounding stage ever runs", () => {
  const repoDir = makeTempRepo();
  const logFile = path.join(repoDir, "pnpm.log");
  const shimDir = makePnpmShim(logFile, 1);

  const result = runHook(repoDir, { pathDirs: [shimDir, realGitDir, "/usr/bin", "/bin"] });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /BLOCKED.*typecheck:fast/su);
  const calls = fs.readFileSync(logFile, "utf8").trim().split("\n");
  assert.equal(calls.length, 1, "only the first failing stage should have invoked pnpm");
});

test("grounding tripwire is SKIPPED when the pushed diff touches no grounding-relevant path", () => {
  const repoDir = makeTempRepo();
  const remoteSha = writeAndCommit(repoDir, "README.md", "base\n", "base");
  const localSha = writeAndCommit(repoDir, "docs/notes.md", "unrelated docs change\n", "docs change");

  const logFile = path.join(repoDir, "pnpm.log");
  const shimDir = makePnpmShim(logFile, 0);

  const result = runHook(repoDir, {
    pathDirs: [shimDir, realGitDir, "/usr/bin", "/bin"],
    input: refUpdateStdin(localSha, remoteSha)
  });

  assert.equal(result.status, 0, result.stderr);
  const calls = fs.readFileSync(logFile, "utf8").trim().split("\n");
  assert.ok(!calls.some((c) => c.includes("precheck:grounding")), "grounding tripwire must NOT run for a docs-only push");
  assert.match(result.stderr, /grounding tripwire skipped \(no grounding-path changes in this push\)/u);
});

test("grounding tripwire RUNS when the pushed diff touches a grounding-relevant path", () => {
  const repoDir = makeTempRepo();
  const remoteSha = writeAndCommit(repoDir, "README.md", "base\n", "base");
  const localSha = writeAndCommit(
    repoDir,
    "packages/agent-core/src/whatever.ts",
    "export const x = 1;\n",
    "agent-core change"
  );

  const logFile = path.join(repoDir, "pnpm.log");
  const shimDir = makePnpmShim(logFile, 0);

  const result = runHook(repoDir, {
    pathDirs: [shimDir, realGitDir, "/usr/bin", "/bin"],
    input: refUpdateStdin(localSha, remoteSha)
  });

  assert.equal(result.status, 0, result.stderr);
  const calls = fs.readFileSync(logFile, "utf8").trim().split("\n");
  assert.ok(calls.some((c) => c.includes("precheck:grounding")), "grounding tripwire must run for an agent-core push");
});

test("grounding tripwire RUNS when a NEW ref (remote sha all-zero) is pushed with a grounding-relevant file", () => {
  const repoDir = makeTempRepo();
  const localSha = writeAndCommit(
    repoDir,
    "packages/recall/src/whatever.ts",
    "export const x = 1;\n",
    "recall change"
  );
  const zero = "0".repeat(40);

  const logFile = path.join(repoDir, "pnpm.log");
  const shimDir = makePnpmShim(logFile, 0);

  const result = runHook(repoDir, {
    pathDirs: [shimDir, realGitDir, "/usr/bin", "/bin"],
    input: refUpdateStdin(localSha, zero)
  });

  assert.equal(result.status, 0, result.stderr);
  const calls = fs.readFileSync(logFile, "utf8").trim().split("\n");
  assert.ok(calls.some((c) => c.includes("precheck:grounding")), "a brand-new ref push must diff against the empty tree and still catch a grounding-relevant file");
});

test("MUSE_SKIP_PREPUSH_ALL=1 skips every stage — no pnpm invocation at all", () => {
  const repoDir = makeTempRepo();
  const logFile = path.join(repoDir, "pnpm.log");
  const shimDir = makePnpmShim(logFile, 0);

  const result = runHook(repoDir, {
    pathDirs: [shimDir, realGitDir, "/usr/bin", "/bin"],
    env: { MUSE_SKIP_PREPUSH_ALL: "1" }
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(logFile), false, "no pnpm command should have run");
  assert.match(result.stderr, /ALL stages skipped/u);
});
