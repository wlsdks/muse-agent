import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createEvalTrialEnvironment } from "./lib/eval-trial-environment.mjs";

test("isolates runtime state, restores process env, and removes the whole trial", async () => {
  const originalHome = process.env.HOME;
  const originalTokenFile = process.env.MUSE_TOKEN_USAGE_FILE;
  const originalUnlistedStateFile = process.env.MUSE_OWNER_ONLY_PROBE_FILE;
  process.env.HOME = "/sentinel-owner-home";
  process.env.MUSE_TOKEN_USAGE_FILE = "/sentinel-owner-token-usage.jsonl";
  process.env.MUSE_OWNER_ONLY_PROBE_FILE = "/sentinel-owner-private.json";

  let trial;
  try {
    try {
      trial = await createEvalTrialEnvironment({ prefix: "muse-eval-env-test-" });
      assert.notEqual(process.env.HOME, "/sentinel-owner-home");
      assert.equal(process.env.MUSE_USER_MEMORY_AUTO_EXTRACT, "false");
      assert.equal(process.env.MUSE_CHECKPOINTS_DIR, join(trial.home, ".muse", "checkpoints"));
      assert.equal(process.env.MUSE_TOKEN_USAGE_FILE, join(trial.home, ".muse", "token-usage.jsonl"));
      assert.equal(process.env.MUSE_OWNER_ONLY_PROBE_FILE, undefined);
      assert.equal(trial.env.HOME, trial.home);

      await mkdir(process.env.MUSE_CHECKPOINTS_DIR, { recursive: true });
      await writeFile(join(process.env.MUSE_CHECKPOINTS_DIR, "probe.json"), "{}\n");
    } finally {
      await trial?.dispose();
    }

    assert.equal(process.env.HOME, "/sentinel-owner-home");
    assert.equal(process.env.MUSE_TOKEN_USAGE_FILE, "/sentinel-owner-token-usage.jsonl");
    assert.equal(process.env.MUSE_OWNER_ONLY_PROBE_FILE, "/sentinel-owner-private.json");
    await assert.rejects(access(trial.root));
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalTokenFile === undefined) delete process.env.MUSE_TOKEN_USAGE_FILE;
    else process.env.MUSE_TOKEN_USAGE_FILE = originalTokenFile;
    if (originalUnlistedStateFile === undefined) delete process.env.MUSE_OWNER_ONLY_PROBE_FILE;
    else process.env.MUSE_OWNER_ONLY_PROBE_FILE = originalUnlistedStateFile;
  }

});

test("rejects overlapping process-wide trial environments and releases the lease", async () => {
  const first = await createEvalTrialEnvironment({ prefix: "muse-eval-env-first-" });
  try {
    await assert.rejects(
      createEvalTrialEnvironment({ prefix: "muse-eval-env-overlap-" }),
      /already active/u
    );
  } finally {
    await first.dispose();
  }

  const after = await createEvalTrialEnvironment({ prefix: "muse-eval-env-after-" });
  await after.dispose();
});

test("an inherited task-memory sentinel is neither read nor rewritten and is restored", async () => {
  const ownerRoot = await mkdtemp(join(tmpdir(), "muse-eval-owner-sentinel-"));
  const ownerFile = join(ownerRoot, "task-memory.json");
  const ownerContents = "OWNER-STATE-MUST-STAY-BYTE-IDENTICAL\n";
  const originalTaskMemoryFile = process.env.MUSE_TASK_MEMORY_FILE;
  await writeFile(ownerFile, ownerContents);
  process.env.MUSE_TASK_MEMORY_FILE = ownerFile;

  let trial;
  try {
    trial = await createEvalTrialEnvironment({ prefix: "muse-eval-hostile-task-memory-" });
    assert.notEqual(trial.env.MUSE_TASK_MEMORY_FILE, ownerFile);
    const { createMuseRuntimeAssembly } = await import("../packages/autoconfigure/dist/index.js");
    const assembly = createMuseRuntimeAssembly({ env: trial.env });
    await assembly.taskMemoryStore.findActiveBySession("hostile-sentinel-session", "eval-user");
    assert.match(await readFile(trial.env.MUSE_TASK_MEMORY_FILE, "utf8"), /"tasks"/u);
    await trial.dispose();

    assert.equal(process.env.MUSE_TASK_MEMORY_FILE, ownerFile);
    assert.equal(await readFile(ownerFile, "utf8"), ownerContents);
    await assert.rejects(access(trial.root));
  } finally {
    await trial?.dispose();
    if (originalTaskMemoryFile === undefined) delete process.env.MUSE_TASK_MEMORY_FILE;
    else process.env.MUSE_TASK_MEMORY_FILE = originalTaskMemoryFile;
    await rm(ownerRoot, { force: true, recursive: true });
  }
});

test("every live coding assembly creates and injects a disposable trial first", async () => {
  const batteries = [
    "eval-computer-task.mjs",
    "eval-edit-run-verify.mjs",
    "eval-multifile-fix.mjs",
    "eval-reverify-fix.mjs",
    "eval-run-command.mjs",
    "eval-two-edit-fix.mjs"
  ];

  for (const battery of batteries) {
    const source = await readFile(join(import.meta.dirname, battery), "utf8");
    assert.match(source, /createEvalTrialEnvironment/u, battery);
    assert.match(source, /env: trial\.env/u, battery);
    assert.match(source, /await trial\?\.dispose\(\)/u, battery);
    assert.doesNotMatch(source, /import \{ createMuseRuntimeAssembly \}/u, battery);
    assert.ok(
      source.indexOf("trial = await createEvalTrialEnvironment") < source.indexOf("const assembly = createMuseRuntimeAssembly"),
      `${battery}: isolation must be installed before assembly creation`
    );
  }

  const browser = await readFile(join(import.meta.dirname, "eval-browser-agent.mjs"), "utf8");
  assert.match(browser, /createEvalTrialEnvironment/u);
  assert.match(browser, /env: environment\.env/u);
  assert.match(browser, /await environment\?\.dispose\(\)/u);

  const grounding = await readFile(
    join(import.meta.dirname, "..", "apps", "cli", "scripts", "verify-tool-arg-grounding.mjs"),
    "utf8"
  );
  assert.match(grounding, /createEvalTrialEnvironment/u);
  assert.match(grounding, /createMuseRuntimeAssembly\(\{ env: environment\.env \}\)/u);
  assert.match(grounding, /await environment\.dispose\(\)/u);
  assert.doesNotMatch(grounding, /import \{ createMuseRuntimeAssembly \}/u);
  assert.ok(
    grounding.indexOf("const environment = await createEvalTrialEnvironment") <
      grounding.indexOf("const asm = createMuseRuntimeAssembly"),
    "tool-arg-grounding must install isolation before assembly creation"
  );

  const discovered = [];
  for (const file of await readdir(import.meta.dirname)) {
    if (!file.startsWith("eval-") || file.endsWith(".test.mjs")) continue;
    const source = await readFile(join(import.meta.dirname, file), "utf8");
    if (source.includes("createMuseRuntimeAssembly")) discovered.push(file);
  }
  assert.deepEqual(discovered.sort(), [...batteries, "eval-browser-agent.mjs"].sort());
});
