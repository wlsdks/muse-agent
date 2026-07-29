import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { evaluateReleaseEvidence } from "./eval-release-evidence.mjs";

function git(repoRoot, args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

test("binds a git-archive candidate to clean source and emits hashed-only red evidence", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "muse-release-evidence-"));
  const candidate = join(repoRoot, "candidate.tar");
  const output = join(repoRoot, "receipt.json");
  const syntheticToken = ["AK", "IA", "A".repeat(16)].join("");
  const fixedNow = new Date("2030-01-02T03:04:05.000Z");
  try {
    git(repoRoot, ["init", "-q"]);
    git(repoRoot, ["config", "user.email", "fixture@example.invalid"]);
    git(repoRoot, ["config", "user.name", "Fixture"]);
    writeFileSync(join(repoRoot, ".gitignore"), "candidate.tar\nreceipt.json\nskipped.json\n", "utf8");
    writeFileSync(join(repoRoot, "safe.txt"), `fixture ${syntheticToken}\n`, "utf8");
    git(repoRoot, ["add", "."]);
    git(repoRoot, ["commit", "-qm", "fixture"]);
    const head = git(repoRoot, ["rev-parse", "HEAD"]);
    const tree = git(repoRoot, ["rev-parse", "HEAD^{tree}"]);
    git(repoRoot, ["archive", "--format=tar", `--output=${candidate}`, "HEAD"]);

    const report = evaluateReleaseEvidence({
      candidatePath: candidate,
      now: () => fixedNow,
      outputPath: output,
      repoRoot
    });
    const repeated = evaluateReleaseEvidence({
      candidatePath: candidate,
      now: () => fixedNow,
      outputPath: output,
      repoRoot
    });

    assert.deepEqual(repeated, report);
    assert.equal(report.overall, "red");
    assert.equal(report.generatedAt, fixedNow.toISOString());
    assert.equal(report.inputHashAlgorithm, "sha256");
    assert.match(report.inputHash, /^[a-f0-9]{64}$/u);
    assert.deepEqual(report.source, { clean: true, head, tree });
    assert.equal(report.candidate.commit, head);
    assert.equal(report.candidate.tree, tree);
    assert.equal(report.candidate.matchesCurrent, true);
    assert.match(report.candidate.sha256, /^[a-f0-9]{64}$/u);
    assert.ok(report.candidate.byteSize > 0);
    assert.equal(report.scans.source.status, "complete");
    assert.equal(report.scans.candidate.status, "complete");
    assert.ok(report.scans.source.bytes > 0);
    assert.ok(report.scans.candidate.bytes > 0);
    assert.equal(report.scans.source.specialEntries, 0);
    assert.equal(report.scans.candidate.specialEntries, 0);
    assert.equal(report.scans.candidate.duplicateEntries, 0);
    assert.equal(report.signatures.commit, "unverified");
    assert.equal(report.signatures.candidateDetached, "absent");
    assert.equal(report.signatures.tagsAtHead.length, 0);
    assert.ok(report.findings.some((finding) => finding.scope === "source"));
    assert.ok(report.findings.some((finding) => finding.scope === "candidate"));
    for (const finding of report.findings) {
      assert.deepEqual(Object.keys(finding).sort(), ["line", "matchHash", "path", "ruleId", "scope"]);
      assert.match(finding.matchHash, /^[a-f0-9]{64}$/u);
    }
    const serialized = JSON.stringify(report);
    assert.doesNotMatch(serialized, new RegExp(syntheticToken, "u"));
    assert.equal(readFileSync(output, "utf8"), `${JSON.stringify(report, null, 2)}\n`);
    if (process.platform !== "win32") assert.equal(statSync(output).mode & 0o777, 0o600);

    const skipped = evaluateReleaseEvidence({
      candidatePath: candidate,
      outputPath: join(repoRoot, "skipped.json"),
      repoRoot,
      now: () => fixedNow,
      spawn: (command, args, options) => command === "tar" && args[0] === "--version"
        ? { error: undefined, signal: null, status: 127, stderr: "", stdout: "" }
        : spawnSync(command, args, options)
    });
    assert.deepEqual(skipped.scans.candidate, {
      bytes: 0,
      duplicateEntries: 0,
      entries: 0,
      specialEntries: 0,
      status: "skipped",
      tool: "tar-unavailable"
    });
    assert.equal(skipped.overall, "red");
    assert.ok(skipped.reasons.includes("scan-skipped"));
  } finally {
    rmSync(repoRoot, { force: true, recursive: true });
  }
});

test("marks duplicate archive member names as skipped and red", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "muse-release-evidence-tar-duplicate-"));
  try {
    git(repoRoot, ["init", "-q"]);
    git(repoRoot, ["config", "user.email", "fixture@example.invalid"]);
    git(repoRoot, ["config", "user.name", "Fixture"]);
    writeFileSync(join(repoRoot, ".gitignore"), "candidate.tar\nreceipt.json\n", "utf8");
    const duplicatedPath = join(repoRoot, "regular.txt");
    writeFileSync(duplicatedPath, "safe\n", "utf8");
    git(repoRoot, ["add", "."]);
    git(repoRoot, ["commit", "-qm", "fixture"]);
    const candidate = join(repoRoot, "candidate.tar");
    git(repoRoot, ["archive", "--format=tar", `--output=${candidate}`, "HEAD"]);
    unlinkSync(duplicatedPath);
    symlinkSync("elsewhere.txt", duplicatedPath);
    execFileSync("tar", ["-rf", candidate, "-C", repoRoot, "regular.txt"]);

    const report = evaluateReleaseEvidence({
      candidatePath: candidate,
      outputPath: join(repoRoot, "receipt.json"),
      repoRoot
    });

    assert.equal(report.candidate.matchesCurrent, true);
    assert.equal(report.scans.candidate.status, "skipped");
    assert.equal(report.scans.candidate.duplicateEntries, 2);
    assert.ok(report.reasons.includes("scan-skipped"));
  } finally {
    rmSync(repoRoot, { force: true, recursive: true });
  }
});

test("fails before receipt mutation for unsafe candidate and output boundaries", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "muse-release-evidence-boundary-"));
  try {
    git(repoRoot, ["init", "-q"]);
    git(repoRoot, ["config", "user.email", "fixture@example.invalid"]);
    git(repoRoot, ["config", "user.name", "Fixture"]);
    writeFileSync(join(repoRoot, ".gitignore"), "receipt.json\n", "utf8");
    writeFileSync(join(repoRoot, "tracked.txt"), "safe\n", "utf8");
    git(repoRoot, ["add", "."]);
    git(repoRoot, ["commit", "-qm", "fixture"]);
    const regular = join(repoRoot, "candidate.tar");
    git(repoRoot, ["archive", "--format=tar", `--output=${regular}`, "HEAD"]);
    const linked = join(repoRoot, "linked.tar");
    symlinkSync(regular, linked);

    assert.throws(
      () => evaluateReleaseEvidence({
        candidatePath: linked,
        outputPath: join(repoRoot, "receipt.json"),
        repoRoot
      }),
      /candidate boundary/u
    );
    assert.throws(
      () => evaluateReleaseEvidence({
        candidatePath: regular,
        outputPath: join(repoRoot, "tracked-output.json"),
        repoRoot
      }),
      /output must be git-ignored/u
    );

    const victim = join(repoRoot, "victim.txt");
    const output = join(repoRoot, "receipt.json");
    writeFileSync(victim, "preserve-me\n", "utf8");
    symlinkSync(victim, output);
    assert.throws(
      () => evaluateReleaseEvidence({
        candidatePath: regular,
        outputPath: output,
        repoRoot
      }),
      /output boundary/u
    );
    assert.equal(readFileSync(victim, "utf8"), "preserve-me\n");
    assert.equal(existsSync(output), true);
  } finally {
    rmSync(repoRoot, { force: true, recursive: true });
  }
});

test("marks a tar candidate with special entries as skipped and red", () => {
  const repoRoot = mkdtempSync(join(tmpdir(), "muse-release-evidence-tar-link-"));
  try {
    git(repoRoot, ["init", "-q"]);
    git(repoRoot, ["config", "user.email", "fixture@example.invalid"]);
    git(repoRoot, ["config", "user.name", "Fixture"]);
    writeFileSync(join(repoRoot, ".gitignore"), "candidate.tar\nreceipt.json\n", "utf8");
    writeFileSync(join(repoRoot, "regular.txt"), "safe\n", "utf8");
    symlinkSync("regular.txt", join(repoRoot, "linked.txt"));
    git(repoRoot, ["add", "."]);
    git(repoRoot, ["commit", "-qm", "fixture"]);
    const candidate = join(repoRoot, "candidate.tar");
    git(repoRoot, ["archive", "--format=tar", `--output=${candidate}`, "HEAD"]);

    const report = evaluateReleaseEvidence({
      candidatePath: candidate,
      outputPath: join(repoRoot, "receipt.json"),
      repoRoot
    });

    assert.equal(report.overall, "red");
    assert.equal(report.scans.candidate.status, "skipped");
    assert.equal(report.scans.candidate.specialEntries, 1);
    assert.ok(report.reasons.includes("scan-skipped"));
  } finally {
    rmSync(repoRoot, { force: true, recursive: true });
  }
});
