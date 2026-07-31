import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { main } from "./eval-agent-artifacts.mjs";

test("--json emits only the exact path-free runtime artifact digest contract", () => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "muse-artifact-probe-")));
  const repoRoot = join(fixture, "repo");
  const artifactRoot = join(fixture, "artifacts");
  mkdirSync(repoRoot);
  mkdirSync(artifactRoot);
  let stdout = "";
  const exitCodes = [];
  try {
    const report = main(["--json", "--artifact-root", artifactRoot], {
      captureArtifacts: () => ({
        count: 41,
        digest: "a".repeat(64),
        privatePath: "/Users/private-owner/muse-runner",
        status: "ok",
      }),
      repoRoot,
      setExitCode: (value) => exitCodes.push(value),
      stdout: { write: (chunk) => { stdout += chunk; } },
    });

    assert.deepEqual(report, { status: "ok", digest: "a".repeat(64), count: 41 });
    assert.deepEqual(JSON.parse(stdout), report);
    assert.deepEqual(Object.keys(report), ["status", "digest", "count"]);
    assert.doesNotMatch(stdout, /Users|private-owner|muse-runner/u);
    assert.deepEqual(exitCodes, []);
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});

test("artifact probe errors fail closed without exposing error or path text", () => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "muse-artifact-probe-error-")));
  const repoRoot = join(fixture, "repo");
  const artifactRoot = join(fixture, "artifacts");
  mkdirSync(repoRoot);
  mkdirSync(artifactRoot);
  let stdout = "";
  const exitCodes = [];
  try {
    const report = main(["--json", "--artifact-root", artifactRoot], {
      captureArtifacts: () => {
        throw new Error("/Users/private-owner/secret-runner");
      },
      repoRoot,
      setExitCode: (value) => exitCodes.push(value),
      stdout: { write: (chunk) => { stdout += chunk; } },
    });

    assert.deepEqual(report, { status: "unknown", count: 0 });
    assert.deepEqual(JSON.parse(stdout), report);
    assert.doesNotMatch(stdout, /Users|private-owner|secret-runner/u);
    assert.deepEqual(exitCodes, [1]);
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});

test("missing or repository-contained artifact roots fail closed before capture", () => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "muse-artifact-probe-root-")));
  const repoRoot = join(fixture, "repo");
  mkdirSync(repoRoot);
  let captureCalls = 0;
  try {
    for (const args of [["--json"], ["--json", "--artifact-root", repoRoot]]) {
      const report = main(args, {
        captureArtifacts: () => {
          captureCalls += 1;
          return { count: 41, digest: "a".repeat(64), status: "ok" };
        },
        repoRoot,
        setExitCode: () => {},
        stdout: { write: () => {} },
      });
      assert.deepEqual(report, { status: "unknown", count: 0 });
    }
    assert.equal(captureCalls, 0);
  } finally {
    rmSync(fixture, { force: true, recursive: true });
  }
});
