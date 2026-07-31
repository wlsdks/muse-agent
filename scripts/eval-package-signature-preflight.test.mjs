import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { runPackageSignaturePreflight } from "./eval-package-signature-preflight.mjs";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "muse-package-preflight-")));
  const artifactRoot = join(root, "artifacts");
  const remote = join(root, "remote.git");
  const repo = join(root, "repo");
  mkdirSync(artifactRoot);
  mkdirSync(repo);
  git(root, ["init", "--bare", "-q", remote]);
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.email", "fixture@example.invalid"]);
  git(repo, ["config", "user.name", "Fixture"]);
  writeFileSync(join(repo, "safe.txt"), "fixture\n", "utf8");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "fixture"]);
  git(repo, ["remote", "add", "origin", remote]);
  git(repo, ["push", "-qu", "origin", "HEAD:main"]);
  return { artifactRoot, repo, root };
}

test("creates reproducible source-tree package evidence without signing or release effects", () => {
  const { artifactRoot, repo } = fixture();
  const output = join(artifactRoot, "preflight.json");
  const report = runPackageSignaturePreflight({
    argv: ["--artifact-root", artifactRoot, "--output", output],
    now: () => new Date("2026-07-29T00:00:00.000Z"),
    repoRoot: repo
  });

  assert.equal(report.package.kind, "source-tree-archive");
  assert.equal(report.package.installable, false);
  assert.equal(report.package.byteIdentical, true);
  assert.equal(report.package.firstSha256, report.package.secondSha256);
  assert.equal(report.source.head, report.source.upstream);
  assert.equal(report.source.worktree, "clean");
  assert.equal(report.decision.gate, "red");
  assert.match(report.releaseEvidence.name, /-release-evidence\.json$/u);
  assert.deepEqual(report.effects, {
    archiveWrites: 2,
    credentialUse: 0,
    evidenceWrites: 2,
    network: 0,
    publication: 0,
    release: 0,
    signing: 0,
    tag: 0
  });
  assert.ok(report.decision.missingAuthority.includes("verified-source-signature"));
  assert.ok(report.decision.missingAuthority.includes("verified-detached-candidate-signature"));
  assert.ok(report.decision.missingAuthority.includes("installable-package-definition"));
  assert.equal(statSync(output).mode & 0o777, 0o600);
});

test("refuses dirty and diverged source before creating package artifacts", () => {
  for (const state of ["dirty", "diverged"]) {
    const { artifactRoot, repo } = fixture();
    const output = join(artifactRoot, `${state}.json`);
    if (state === "dirty") writeFileSync(join(repo, "dirty.txt"), "dirty\n", "utf8");
    else {
      writeFileSync(join(repo, "safe.txt"), "diverged\n", "utf8");
      git(repo, ["add", "."]);
      git(repo, ["commit", "-qm", "diverged"]);
    }
    assert.throws(
      () => runPackageSignaturePreflight({
        argv: ["--artifact-root", artifactRoot, "--output", output],
        repoRoot: repo
      }),
      /requires clean source at its normal upstream/u
    );
    assert.equal(existsSync(output), false);
    assert.deepEqual(readFileNames(artifactRoot), []);
  }
});

test("rejects output traversal before creating an external directory", () => {
  const { artifactRoot, repo, root } = fixture();
  const external = join(root, "external", "preflight.json");
  assert.throws(
    () => runPackageSignaturePreflight({
      argv: ["--artifact-root", artifactRoot, "--output", external],
      repoRoot: repo
    }),
    /must stay inside the artifact root/u
  );
  assert.equal(existsSync(dirname(external)), false);
});

test("rejects a dangling candidate symlink before creating its external target", () => {
  const { artifactRoot, repo, root } = fixture();
  const head = git(repo, ["rev-parse", "HEAD"]);
  const output = join(artifactRoot, "preflight.json");
  const external = join(root, "outside-created.tar");
  symlinkSync(external, join(artifactRoot, `pa-s005-source-${head.slice(0, 9)}.tar`));

  assert.throws(
    () => runPackageSignaturePreflight({
      argv: ["--artifact-root", artifactRoot, "--output", output],
      repoRoot: repo
    }),
    /target already exists or is unsafe/u
  );
  assert.equal(existsSync(external), false);
  assert.equal(existsSync(output), false);
});

test("detects a parent swap before any archive or evidence write", () => {
  const { artifactRoot, repo, root } = fixture();
  const moved = join(root, "moved-artifacts");
  const external = join(root, "external-roadmap");
  const output = join(artifactRoot, "preflight.json");
  mkdirSync(external);

  assert.throws(
    () => runPackageSignaturePreflight({
      argv: ["--artifact-root", artifactRoot, "--output", output],
      now: () => {
        renameSync(artifactRoot, moved);
        symlinkSync(external, artifactRoot);
        return new Date("2026-07-29T00:00:00.000Z");
      },
      repoRoot: repo
    }),
    /artifact root is unsafe/u
  );
  assert.deepEqual(readdirSync(external), []);
});

test("requires an explicit artifact root outside the repository", () => {
  const { artifactRoot, repo } = fixture();
  const output = join(artifactRoot, "preflight.json");
  assert.throws(
    () => runPackageSignaturePreflight({ argv: ["--output", output], repoRoot: repo }),
    /--artifact-root/u
  );
  assert.throws(
    () => runPackageSignaturePreflight({
      argv: ["--artifact-root", repo, "--output", join(repo, "preflight.json")],
      repoRoot: repo
    }),
    /artifact root must stay outside the repository/u
  );
  assert.equal(existsSync(output), false);
});

test("rejects an artifact root reached through a symlinked parent", () => {
  const { repo, root } = fixture();
  const canonicalParent = join(root, "canonical-parent");
  const artifactRoot = join(canonicalParent, "artifacts");
  const aliasParent = join(root, "alias-parent");
  mkdirSync(artifactRoot, { recursive: true });
  symlinkSync(canonicalParent, aliasParent, "dir");
  const aliasedRoot = join(aliasParent, "artifacts");

  assert.throws(
    () => runPackageSignaturePreflight({
      argv: ["--artifact-root", aliasedRoot, "--output", join(aliasedRoot, "preflight.json")],
      repoRoot: repo
    }),
    /artifact root is unsafe/u
  );
  assert.deepEqual(readFileNames(artifactRoot), []);
});

function readFileNames(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
}
