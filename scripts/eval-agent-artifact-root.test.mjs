import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertCapabilityArtifactRoot,
  bindCapabilityArtifactRoot,
  capabilityReportPath,
  capabilityRunnerPath,
} from "./eval-agent-artifact-root.mjs";

test("binds one canonical external root to fixed capability report and runner paths", () => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "muse-capability-root-")));
  const repoRoot = join(fixture, "repo");
  const artifactRoot = join(fixture, "artifacts");
  try {
    mkdirSync(repoRoot);
    mkdirSync(artifactRoot);
    const binding = bindCapabilityArtifactRoot(repoRoot, artifactRoot);

    assert.equal(binding.root, artifactRoot);
    assert.equal(capabilityReportPath(binding), join(artifactRoot, "latest.json"));
    assert.equal(
      capabilityRunnerPath(binding),
      join(
        artifactRoot,
        process.platform === "win32" ? "muse-runner.exe" : "muse-runner",
      ),
    );
    assert.doesNotThrow(() => assertCapabilityArtifactRoot(binding));
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});

test("rejects missing, repository-contained, and symlink-aliased roots", () => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "muse-capability-root-invalid-")));
  const repoRoot = join(fixture, "repo");
  const artifactRoot = join(fixture, "artifacts");
  const alias = join(fixture, "alias");
  try {
    mkdirSync(repoRoot);
    mkdirSync(join(repoRoot, "artifacts"));
    mkdirSync(artifactRoot);
    symlinkSync(artifactRoot, alias, process.platform === "win32" ? "junction" : "dir");

    assert.throws(() => bindCapabilityArtifactRoot(repoRoot, undefined), /artifact-root-required/u);
    assert.throws(
      () => bindCapabilityArtifactRoot(repoRoot, join(repoRoot, "artifacts")),
      /artifact-root-outside-repository/u,
    );
    assert.throws(
      () => bindCapabilityArtifactRoot(repoRoot, fixture),
      /artifact-root-outside-repository/u,
    );
    assert.throws(() => bindCapabilityArtifactRoot(repoRoot, alias), /artifact-root-unsafe/u);
    for (const noncanonical of [
      `${artifactRoot}/.`,
      `${artifactRoot}//`,
      `${artifactRoot}/child/..`,
    ]) {
      assert.throws(
        () => bindCapabilityArtifactRoot(repoRoot, noncanonical),
        /artifact-root-unsafe/u,
      );
    }
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});

test("a bound root fails closed after path replacement", () => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "muse-capability-root-swap-")));
  const repoRoot = join(fixture, "repo");
  const artifactRoot = join(fixture, "artifacts");
  const moved = join(fixture, "moved");
  const replacement = join(fixture, "replacement");
  try {
    mkdirSync(repoRoot);
    mkdirSync(artifactRoot);
    mkdirSync(replacement);
    const binding = bindCapabilityArtifactRoot(repoRoot, artifactRoot);
    renameSync(artifactRoot, moved);
    renameSync(replacement, artifactRoot);

    assert.throws(() => assertCapabilityArtifactRoot(binding), /artifact-root-changed/u);
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});
