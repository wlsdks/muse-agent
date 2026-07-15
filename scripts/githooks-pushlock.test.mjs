// node --test coverage for scripts/githooks/lib/pushlock.sh's mkdir-spinlock
// (the macOS-default path — no real flock(1) is assumed present). Drives the
// script's direct-invocation test entry as a real bash subprocess; never
// touches a real push or real git config.

import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pushlockScript = path.join(here, "githooks", "lib", "pushlock.sh");

function tempPath(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return path.join(dir, "lock");
}

function makeRepoWithTwoWorktrees() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "muse-pushlock-worktrees-"));
  const mainDir = path.join(root, "main");
  fs.mkdirSync(mainDir);
  execFileSync("git", ["init", "--quiet"], { cwd: mainDir });
  execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: mainDir });
  execFileSync("git", ["config", "user.name", "Muse Test"], { cwd: mainDir });
  execFileSync("git", ["commit", "--quiet", "--allow-empty", "-m", "init"], { cwd: mainDir });
  const wtA = path.join(root, "wtA");
  const wtB = path.join(root, "wtB");
  execFileSync("git", ["worktree", "add", "--quiet", wtA, "-b", "wtA"], { cwd: mainDir });
  execFileSync("git", ["worktree", "add", "--quiet", wtB, "-b", "wtB"], { cwd: mainDir });
  return { root, mainDir, wtA, wtB };
}

function resolvedTargetFrom(cwd) {
  const result = spawnSync(
    "bash",
    ["-c", `source "${pushlockScript.replace(/"/gu, '\\"')}" && pushlock_repo_target`],
    { cwd, encoding: "utf8" }
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function runPushlock(lockPath, holdSeconds, logFile, env = {}) {
  return spawn("bash", [pushlockScript, lockPath, String(holdSeconds), logFile], {
    env: { ...process.env, ...env }
  });
}

function waitForExit(child) {
  return new Promise((resolve) => {
    child.on("exit", (code) => resolve(code));
  });
}

test("two concurrent invocations serialize — never both hold the lock at once", async () => {
  const lockPath = tempPath("muse-pushlock-serialize-");
  const logFile = tempPath("muse-pushlock-log-") + ".log";
  fs.writeFileSync(logFile, "");

  const a = runPushlock(lockPath, 0.4, logFile);
  const b = runPushlock(lockPath, 0.4, logFile);
  const [codeA, codeB] = await Promise.all([waitForExit(a), waitForExit(b)]);

  assert.equal(codeA, 0);
  assert.equal(codeB, 0);

  const lines = fs.readFileSync(logFile, "utf8").trim().split("\n");
  assert.equal(lines.length, 4);
  // Serialized: start,end MUST pair up before the next start ever appears —
  // "start,start,end,end" is the interleaved failure this lock exists to prevent.
  assert.match(lines[0], /^start:/u);
  assert.match(lines[1], /^end:/u);
  assert.match(lines[2], /^start:/u);
  assert.match(lines[3], /^end:/u);
  const [, pidA] = lines[0].split(":");
  const [, pidAEnd] = lines[1].split(":");
  assert.equal(pidA, pidAEnd, "the first holder's start/end must be the same process");
});

test("a stale lock (older than the timeout) is reclaimed instead of deadlocking forever", async () => {
  const lockPath = tempPath("muse-pushlock-stale-");
  const lockDir = `${lockPath}.d`;
  fs.mkdirSync(lockDir, { recursive: true });
  const past = new Date(Date.now() - 20_000);
  fs.utimesSync(lockDir, past, past);

  const logFile = tempPath("muse-pushlock-stale-log-") + ".log";
  fs.writeFileSync(logFile, "");

  const child = runPushlock(lockPath, 0.1, logFile, { MUSE_PREPUSH_LOCK_TIMEOUT: "1" });
  const code = await waitForExit(child);
  assert.equal(code, 0);
  const lines = fs.readFileSync(logFile, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
});

test("lock directory is released after the holder exits", async () => {
  const lockPath = tempPath("muse-pushlock-release-");
  const logFile = tempPath("muse-pushlock-release-log-") + ".log";
  fs.writeFileSync(logFile, "");

  const child = runPushlock(lockPath, 0.1, logFile);
  await waitForExit(child);
  assert.equal(fs.existsSync(`${lockPath}.d`), false, "the mkdir-lock directory must be removed on exit (EXIT trap)");
});

test("acquiring the lock times out and exits nonzero when it cannot be obtained in time", async () => {
  const lockPath = tempPath("muse-pushlock-timeout-");
  const lockDir = `${lockPath}.d`;
  fs.mkdirSync(lockDir, { recursive: true });
  const now = new Date();
  fs.utimesSync(lockDir, now, now);

  const logFile = tempPath("muse-pushlock-timeout-log-") + ".log";
  fs.writeFileSync(logFile, "");

  // A LIVE holder heartbeats the lock mtime (pushlock refreshes it every 30s
  // in production; compressed here) — keep it fresh so the waiter can never
  // stale-reclaim and must hit the give-up bound (2x the reclaim timeout).
  const heartbeat = setInterval(() => {
    const tick = new Date();
    try { fs.utimesSync(lockDir, tick, tick); } catch { /* gone = test over */ }
  }, 300);
  const child = runPushlock(lockPath, 0.1, logFile, { MUSE_PREPUSH_LOCK_TIMEOUT: "1" });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const code = await waitForExit(child);
  clearInterval(heartbeat);
  assert.notEqual(code, 0);
  assert.match(stderr, /BLOCKED/u);
  assert.equal(fs.readFileSync(logFile, "utf8"), "");
});

test("pushlock_repo_target resolves to the SAME lock path from every worktree of a repo", () => {
  const { root, wtA, wtB } = makeRepoWithTwoWorktrees();
  try {
    const targetFromA = resolvedTargetFrom(wtA);
    const targetFromB = resolvedTargetFrom(wtB);
    assert.ok(targetFromA.length > 0, "worktree A must resolve a non-empty lock target");
    assert.equal(targetFromA, targetFromB, "both worktrees of the same repo must derive the identical shared lock path");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("regression: a push from worktree A and a push from worktree B contend on the SAME lock — never two independent ones", async () => {
  const { root, wtA, wtB } = makeRepoWithTwoWorktrees();
  try {
    const target = resolvedTargetFrom(wtA);
    const logFile = tempPath("muse-pushlock-worktree-log-") + ".log";
    fs.writeFileSync(logFile, "");

    const a = spawn("bash", [pushlockScript, target, "0.4", logFile], { cwd: wtA });
    const b = spawn("bash", [pushlockScript, target, "0.4", logFile], { cwd: wtB });
    const [codeA, codeB] = await Promise.all([waitForExit(a), waitForExit(b)]);

    assert.equal(codeA, 0);
    assert.equal(codeB, 0);
    const lines = fs.readFileSync(logFile, "utf8").trim().split("\n");
    assert.equal(lines.length, 4);
    // Same failure shape as the single-worktree serialize test: the bug this
    // regression test is for is "start,start,end,end" — worktree A's push
    // landing mid-hook of worktree B's push because each resolved its OWN
    // lock path instead of the shared one.
    assert.match(lines[0], /^start:/u);
    assert.match(lines[1], /^end:/u);
    assert.match(lines[2], /^start:/u);
    assert.match(lines[3], /^end:/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pushlock.sh is executable and shellcheck-clean where shellcheck is available", () => {
  assert.equal(fs.statSync(pushlockScript).mode & 0o111, 0o111);
  try {
    execFileSync("shellcheck", [pushlockScript], { encoding: "utf8" });
  } catch (error) {
    if (error.code === "ENOENT") return; // shellcheck not installed — skip
    throw error;
  }
});
