import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  MAX_EVAL_PROCESS_DEADLINE_MS,
  MAX_EVAL_PROCESS_OUTPUT_BYTES,
  runBoundedEvalProcess
} from "./eval-agent-process.mjs";

const child = (source, args = [], options = {}) => runBoundedEvalProcess(
  process.execPath,
  ["-e", source, ...args],
  {
    deadlineMs: 2_000,
    killGraceMs: 50,
    ...options
  }
);

test("preserves a normal exit and captures stdout/stderr", async () => {
  const result = await child(
    'process.stdout.write("ok"); process.stderr.write("warn");'
  );

  assert.deepEqual(result, {
    durationMs: result.durationMs,
    signal: null,
    spawnError: false,
    status: 0,
    stderr: "warn",
    stderrTruncated: false,
    stdout: "ok",
    stdoutTruncated: false,
    timedOut: false
  });
  assert.ok(result.durationMs < 2_000);
});

test("bounds captured stdout and stderr independently", async () => {
  const result = await child(
    'process.stdout.write("abcdefgh"); process.stderr.write("12345678");',
    [],
    { maxOutputBytes: 5 }
  );

  assert.equal(result.stdout, "abcde");
  assert.equal(result.stderr, "12345");
  assert.equal(result.stdoutTruncated, true);
  assert.equal(result.stderrTruncated, true);
});

test("rejects deadlines above the successor command cap", async () => {
  await assert.rejects(
    runBoundedEvalProcess(process.execPath, ["--version"], {
      deadlineMs: MAX_EVAL_PROCESS_DEADLINE_MS + 1
    }),
    /deadlineMs/u
  );
});

test("rejects output caps that could turn a child into an unbounded memory sink", async () => {
  await assert.rejects(
    runBoundedEvalProcess(process.execPath, ["--version"], {
      deadlineMs: 1_000,
      maxOutputBytes: MAX_EVAL_PROCESS_OUTPUT_BYTES + 1
    }),
    /maxOutputBytes/u
  );
});

test("spawn failures return a fail-closed terminal result", async () => {
  const result = await runBoundedEvalProcess("/definitely/missing/muse-command", [], {
    deadlineMs: 1_000,
    killGraceMs: 50
  });

  assert.equal(result.status, null);
  assert.equal(result.spawnError, true);
  assert.equal(result.timedOut, false);
});

test("a timeout removes the owned child and grandchild process group", {
  skip: process.platform === "win32"
}, async () => {
  const root = mkdtempSync(join(tmpdir(), "muse-eval-process-"));
  const pidFile = join(root, "grandchild.pid");
  try {
    const source = [
      'const { spawn } = require("node:child_process");',
      'const { writeFileSync } = require("node:fs");',
      'const grandchild = spawn(process.execPath, ["-e", "process.on(\\\"SIGTERM\\\", () => {}); setInterval(() => {}, 1000);"], { stdio: "ignore" });',
      "writeFileSync(process.argv[1], String(grandchild.pid));",
      'process.on("SIGTERM", () => {});',
      "setInterval(() => {}, 1000);"
    ].join("\n");
    const result = await child(source, [pidFile], {
      deadlineMs: 500,
      killGraceMs: 100
    });

    assert.equal(result.timedOut, true);
    assert.ok(result.durationMs <= 750, `deadline cleanup took ${result.durationMs.toString()}ms`);
    assert.equal(existsSync(pidFile), true);
    const grandchildPid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(Number.isSafeInteger(grandchildPid) && grandchildPid > 0);

    let alive = true;
    const probeDeadline = Date.now() + 2_000;
    while (alive && Date.now() < probeDeadline) {
      try {
        process.kill(grandchildPid, 0);
        await new Promise((resolve) => setTimeout(resolve, 20));
      } catch (cause) {
        if (cause?.code !== "ESRCH") throw cause;
        alive = false;
      }
    }
    assert.equal(alive, false, `grandchild ${grandchildPid.toString()} survived its owned group timeout`);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
