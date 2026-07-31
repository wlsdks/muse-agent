import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";

import {
  buildAndPublishRunner,
  captureGitSourceSnapshot,
  captureRuntimeArtifacts,
  defaultEvalRunnerPath,
  runForcedTypeScriptBuild,
} from "./eval-agent-provenance.mjs";

test("runtime digest binds emitted TS content to an executable owner-only fixed runner", () => {
  const repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "muse-eval-artifacts-")));
  const artifactRoot = realpathSync(mkdtempSync(join(tmpdir(), "muse-eval-artifact-root-")));
  const runnerPath = defaultEvalRunnerPath(artifactRoot);
  try {
    writeFileSync(join(repoRoot, "tsconfig.json"), JSON.stringify({
      files: [],
      references: [{ path: "./packages/example" }],
    }), "utf8");
    mkdirSync(join(repoRoot, "packages", "example", "dist"), { recursive: true });
    writeFileSync(join(repoRoot, "packages", "example", "dist", "index.js"), "export const value = 1;\n", "utf8");
    mkdirSync(dirname(runnerPath), { recursive: true });
    writeFileSync(runnerPath, "runner-binary", "utf8");
    chmodSync(runnerPath, 0o700);

    const first = captureRuntimeArtifacts({ artifactRoot, repoRoot, runnerPath });
    assert.equal(first.status, "ok");
    assert.equal(first.count, 2);
    assert.match(first.digest, /^[a-f0-9]{64}$/u);
    assert.doesNotMatch(JSON.stringify(first), /packages|example|muse-runner/u);

    writeFileSync(join(repoRoot, "packages", "example", "dist", "index.js"), "export const value = 2;\n", "utf8");
    const changed = captureRuntimeArtifacts({ artifactRoot, repoRoot, runnerPath });
    assert.equal(changed.status, "ok");
    assert.notEqual(changed.digest, first.digest);

    chmodSync(runnerPath, 0o600);
    assert.deepEqual(
      captureRuntimeArtifacts({ artifactRoot, repoRoot, runnerPath }),
      { count: 0, status: "unknown" },
    );
  } finally {
    rmSync(repoRoot, { force: true, recursive: true });
    rmSync(artifactRoot, { force: true, recursive: true });
  }
});

test("source and TypeScript probes use no-lock Git and a forced project build", async () => {
  const gitCalls = [];
  const source = await captureGitSourceSnapshot({
    deadlineMs: 7_000,
    now: () => 0,
    repoRoot: "/workspace",
    sourceEnv: { PATH: "/bin" },
    spawn: (command, args, options) => {
      gitCalls.push({ args, command, options });
      return args.includes("rev-parse")
        ? { signal: null, status: 0, stderr: "", stdout: `${"a".repeat(40)}\n` }
        : { signal: null, status: 0, stderr: "", stdout: "" };
    },
  });
  assert.deepEqual(source, { revision: "a".repeat(40), tree: "clean" });
  assert.equal(gitCalls.length, 2);
  assert.ok(gitCalls.every((call) => call.command === "git"));
  assert.ok(gitCalls.every((call) => call.args[0] === "--no-optional-locks"));
  assert.ok(gitCalls.every((call) => call.options.env.GIT_OPTIONAL_LOCKS === "0"));
  assert.ok(gitCalls.every((call) => call.options.deadlineMs === 7_000));
  assert.ok(gitCalls.every((call) => !("timeout" in call.options)));

  const buildRepo = mkdtempSync(join(tmpdir(), "muse-eval-ts-build-"));
  try {
    const project = join(buildRepo, "packages", "example");
    const staleFile = join(project, "dist", "deleted-source.js");
    mkdirSync(dirname(staleFile), { recursive: true });
    writeFileSync(staleFile, "stale runtime", "utf8");
    writeFileSync(join(buildRepo, "tsconfig.json"), JSON.stringify({
      files: [],
      references: [{ path: "./packages/example" }],
    }), "utf8");

    let buildCall;
    const build = await runForcedTypeScriptBuild({
      deadlineMs: 6_000,
      now: () => 0,
      repoRoot: buildRepo,
      sourceEnv: { PATH: "/bin" },
      spawn: (command, args, options) => {
        assert.equal(existsSync(staleFile), false, "stale dist must be gone before tsc starts");
        buildCall = { args, command, options };
        return { signal: null, status: 0, stderr: "", stdout: "" };
      },
    });
    assert.deepEqual(build, { ok: true });
    assert.deepEqual(buildCall.args, ["exec", "tsc", "-b", "--force", "--pretty", "false"]);
    assert.equal(buildCall.options.cwd, buildRepo);
    assert.equal(buildCall.options.deadlineMs, 6_000);
    assert.equal("timeout" in buildCall.options, false);
  } finally {
    rmSync(buildRepo, { force: true, recursive: true });
  }
});

test("elapsed synchronous preparation cannot launch a build after its shared deadline", async () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "muse-eval-build-deadline-"));
  try {
    const project = join(repoRoot, "packages", "example");
    const staleFile = join(project, "dist", "stale.js");
    mkdirSync(dirname(staleFile), { recursive: true });
    writeFileSync(staleFile, "stale", "utf8");
    writeFileSync(join(repoRoot, "tsconfig.json"), JSON.stringify({
      files: [],
      references: [{ path: "./packages/example" }],
    }), "utf8");

    let spawnCalls = 0;
    const timestamps = [0, 7_000];
    const typescript = await runForcedTypeScriptBuild({
      deadlineMs: 6_000,
      now: () => timestamps.shift() ?? 7_000,
      repoRoot,
      spawn: () => {
        spawnCalls += 1;
        return { signal: null, status: 0, stderr: "", stdout: "" };
      },
    });
    assert.deepEqual(typescript, { ok: false, reason: "evaluation-deadline-exhausted" });
    assert.equal(existsSync(staleFile), false);
    assert.equal(spawnCalls, 0);

    const cargoTimestamps = [0, 7_000];
    const cargo = await buildAndPublishRunner({
      deadlineMs: 6_000,
      now: () => cargoTimestamps.shift() ?? 7_000,
      repoRoot,
      spawn: () => {
        spawnCalls += 1;
        return { signal: null, status: 0, stderr: "", stdout: "" };
      },
    });
    assert.deepEqual(cargo, { ok: false, reason: "evaluation-deadline-exhausted" });
    assert.equal(spawnCalls, 0);
  } finally {
    rmSync(repoRoot, { force: true, recursive: true });
  }
});

test("TypeScript cleanup rejects escaped or symlinked dist targets before deleting anything", async () => {
  for (const unsafeKind of ["escaped-reference", "symlinked-dist"]) {
    const repoRoot = mkdtempSync(join(tmpdir(), "muse-eval-ts-safety-"));
    const artifactRoot = realpathSync(mkdtempSync(join(tmpdir(), "muse-eval-ts-artifacts-")));
    const outside = mkdtempSync(join(tmpdir(), "muse-eval-ts-outside-"));
    try {
      const goodProject = join(repoRoot, "packages", "good");
      const goodSentinel = join(goodProject, "dist", "keep.js");
      const outsideDist = join(outside, "dist");
      const outsideSentinel = join(outsideDist, "outside.js");
      mkdirSync(dirname(goodSentinel), { recursive: true });
      mkdirSync(outsideDist, { recursive: true });
      writeFileSync(goodSentinel, "good", "utf8");
      writeFileSync(outsideSentinel, "outside", "utf8");

      const unsafeReference = unsafeKind === "escaped-reference"
        ? relative(repoRoot, outside)
        : "./packages/unsafe";
      if (unsafeKind === "symlinked-dist") {
        const unsafeProject = join(repoRoot, "packages", "unsafe");
        mkdirSync(unsafeProject, { recursive: true });
        symlinkSync(outsideDist, join(unsafeProject, "dist"), "dir");
      }
      writeFileSync(join(repoRoot, "tsconfig.json"), JSON.stringify({
        files: [],
        references: [{ path: "./packages/good" }, { path: unsafeReference }],
      }), "utf8");
      const runnerPath = defaultEvalRunnerPath(artifactRoot);
      mkdirSync(dirname(runnerPath), { recursive: true });
      writeFileSync(runnerPath, "runner", "utf8");
      chmodSync(runnerPath, 0o700);

      let spawnCalls = 0;
      const result = await runForcedTypeScriptBuild({
        repoRoot,
        spawn: () => {
          spawnCalls += 1;
          return { signal: null, status: 0, stderr: "", stdout: "" };
        },
      });
      assert.deepEqual(result, { ok: false, reason: "typescript-build-failed" });
      assert.equal(spawnCalls, 0);
      assert.equal(existsSync(goodSentinel), true, "all refs must validate before any cleanup");
      assert.equal(existsSync(outsideSentinel), true, "cleanup must stay inside the repo");
      assert.deepEqual(
        captureRuntimeArtifacts({ artifactRoot, repoRoot, runnerPath }),
        { count: 0, status: "unknown" },
        "artifact manifests must reject the same unsafe reference graph",
      );
    } finally {
      rmSync(repoRoot, { force: true, recursive: true });
      rmSync(artifactRoot, { force: true, recursive: true });
      rmSync(outside, { force: true, recursive: true });
    }
  }
});

test("runner build uses a fresh locked Cargo target and atomically publishes mode 0700", async () => {
  const repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "muse-eval-runner-build-")));
  const artifactRoot = realpathSync(mkdtempSync(join(tmpdir(), "muse-eval-runner-output-")));
  const runnerPath = defaultEvalRunnerPath(artifactRoot);
  let cargoCall;
  let cargoTarget;
  try {
    mkdirSync(dirname(runnerPath), { recursive: true });
    writeFileSync(runnerPath, "old-runner", "utf8");
    const result = await buildAndPublishRunner({
      deadlineMs: 5_000,
      artifactRoot,
      now: () => 0,
      repoRoot,
      runnerPath,
      sourceEnv: { PATH: "/bin" },
      spawn: (command, args, options) => {
        cargoCall = { args, command, options };
        cargoTarget = options.env.CARGO_TARGET_DIR;
        const built = join(cargoTarget, "debug", "muse-runner");
        mkdirSync(dirname(built), { recursive: true });
        writeFileSync(built, "fresh-runner", "utf8");
        chmodSync(built, 0o755);
        return { signal: null, status: 0, stderr: "", stdout: "" };
      },
    });

    assert.deepEqual(result, { ok: true, runnerPath });
    assert.equal(cargoCall.command, "cargo");
    assert.ok(cargoCall.args.includes("--locked"));
    assert.ok(cargoCall.args.includes(join(repoRoot, "crates", "runner", "Cargo.toml")));
    assert.equal(cargoCall.options.deadlineMs, 5_000);
    assert.equal("timeout" in cargoCall.options, false);
    assert.notEqual(cargoTarget, dirname(runnerPath));
    assert.equal(existsSync(cargoTarget), false);
    assert.equal(readFileSync(runnerPath, "utf8"), "fresh-runner");
    if (process.platform !== "win32") assert.equal(statSync(runnerPath).mode & 0o777, 0o700);
  } finally {
    rmSync(repoRoot, { force: true, recursive: true });
    rmSync(artifactRoot, { force: true, recursive: true });
  }
});

test("runner artifact-root replacement cannot redirect fixed publish or qualification", async () => {
  const repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "muse-eval-runner-symlink-")));
  const artifactRoot = realpathSync(mkdtempSync(join(tmpdir(), "muse-eval-runner-output-")));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "muse-eval-runner-outside-")));
  const runnerPath = defaultEvalRunnerPath(artifactRoot);
  const outsideRunner = join(outside, "muse-runner");
  const movedRoot = `${artifactRoot}-moved`;
  try {
    writeFileSync(join(repoRoot, "tsconfig.json"), JSON.stringify({
      files: [],
      references: [{ path: "./packages/example" }],
    }), "utf8");
    const dist = join(repoRoot, "packages", "example", "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.js"), "export {};\n", "utf8");

    renameSync(artifactRoot, movedRoot);
    symlinkSync(outside, artifactRoot, "dir");

    const build = await buildAndPublishRunner({
      artifactRoot,
      repoRoot,
      runnerPath,
      spawn: (_command, _args, options) => {
        const builtRunner = join(options.env.CARGO_TARGET_DIR, "debug", "muse-runner");
        mkdirSync(dirname(builtRunner), { recursive: true });
        writeFileSync(builtRunner, "fresh-runner", "utf8");
        chmodSync(builtRunner, 0o755);
        return { signal: null, status: 0, stderr: "", stdout: "" };
      },
    });
    assert.deepEqual(build, { ok: false, reason: "runner-publish-failed" });
    assert.equal(existsSync(outsideRunner), false);

    writeFileSync(outsideRunner, "external-runner", "utf8");
    chmodSync(outsideRunner, 0o700);
    assert.deepEqual(
      captureRuntimeArtifacts({ artifactRoot, repoRoot, runnerPath }),
      { count: 0, status: "unknown" },
    );
  } finally {
    rmSync(repoRoot, { force: true, recursive: true });
    rmSync(artifactRoot, { force: true, recursive: true });
    rmSync(movedRoot, { force: true, recursive: true });
    rmSync(outside, { force: true, recursive: true });
  }
});
