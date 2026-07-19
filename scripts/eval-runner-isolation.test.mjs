import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createEvalRunnerTool,
  resolveEvalRunnerIsolationSkip
} from "./lib/eval-runner-isolation.mjs";

test("Luna probe: an absolute cwd outside the fixture fails before runner invocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "muse-eval-runner-root-"));
  const outside = await mkdtemp(join(tmpdir(), "muse-eval-runner-outside-"));
  let invocations = 0;
  const tool = createEvalRunnerTool({
    fixtureRoot: root,
    invokeRunner: async () => {
      invocations += 1;
      throw new Error("runner must not be invoked");
    }
  });

  try {
    await assert.rejects(
      tool.execute({ command: "pwd", cwd: outside }, { runId: "luna-outside-cwd" }),
      /cwd.*isolated root/iu
    );
    assert.equal(invocations, 0);
  } finally {
    await rm(root, { force: true, recursive: true });
    await rm(outside, { force: true, recursive: true });
  }
});

test("eval runner defaults cwd and strict isolationRoot to the exact canonical fixture", async () => {
  const root = await mkdtemp(join(tmpdir(), "muse-eval-runner-default-"));
  let captured;
  const tool = createEvalRunnerTool({
    fixtureRoot: root,
    invokeRunner: async (request) => {
      captured = request;
      return { error: null, ok: true, status: 0, stderr: "", stdout: "", timedOut: false, truncated: false };
    }
  });

  try {
    await tool.execute({ command: "pwd" }, { runId: "default-cwd" });
    const canonical = await realpath(root);
    assert.equal(captured.cwd, canonical);
    assert.equal(captured.isolationRoot, canonical);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("unsupported or unavailable strict isolation is a recognized sandbox-missing skip", () => {
  assert.deepEqual(
    resolveEvalRunnerIsolationSkip({ platform: "linux", sandboxExecExists: true }),
    { code: "sandbox-missing", message: "strict runner isolation requires macOS Seatbelt" }
  );
  assert.deepEqual(
    resolveEvalRunnerIsolationSkip({ platform: "darwin", sandboxExecExists: false }),
    { code: "sandbox-missing", message: "strict runner isolation requires /usr/bin/sandbox-exec" }
  );
  assert.equal(resolveEvalRunnerIsolationSkip({ platform: "darwin", sandboxExecExists: true }), undefined);
});

test("every live coding/command battery with run_command uses the strict fixture helper", async () => {
  for (const file of [
    "eval-edit-run-verify.mjs",
    "eval-multifile-fix.mjs",
    "eval-reverify-fix.mjs",
    "eval-two-edit-fix.mjs",
    "eval-run-command.mjs"
  ]) {
    const source = await readFile(new URL(file, import.meta.url), "utf8");
    assert.match(source, /createEvalRunnerTool\(\{ fixtureRoot: dir, runnerPath: RUNNER \}\)/u, file);
    assert.match(source, /resolveEvalRunnerIsolationSkip\(\)/u, file);
    assert.match(source, /skipLine\(isolationSkip\.code/u, file);
    assert.doesNotMatch(source, /createRustRunnerTool/u, file);
  }
});

test("computer-task stays file-tool-only and exposes no command runner", async () => {
  const source = await readFile(new URL("eval-computer-task.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /create(?:Eval|Rust)RunnerTool|run_command/u);
});

const releaseRunner = join(process.cwd(), "target", "release", "muse-runner");
test("real release runner executes Node inside the strict fixture and denies Homebrew contents", {
  skip: process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec") || !existsSync(releaseRunner)
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "muse-eval-runner-real-node-"));
  await writeFile(join(root, "report.mjs"), "console.log('STRICT-EVAL-NODE-OK');\n");
  try {
    const tool = createEvalRunnerTool({ fixtureRoot: root, runnerPath: releaseRunner });
    const result = await tool.execute(
      { args: ["report.mjs"], command: "node" },
      { runId: "real-strict-node" }
    );
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.match(result.stdout, /STRICT-EVAL-NODE-OK/u);

    const homebrewProbe = "/opt/homebrew/README.md";
    if (existsSync(homebrewProbe)) {
      const denied = await tool.execute(
        { args: [homebrewProbe], command: "cat" },
        { runId: "real-strict-homebrew-denied" }
      );
      assert.equal(denied.ok, false, JSON.stringify(denied));
      assert.equal(denied.stdout, "", JSON.stringify(denied));
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
