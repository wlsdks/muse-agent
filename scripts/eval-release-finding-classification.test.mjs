import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  evaluateReleaseEvidence,
  releaseEvidenceInputHash,
} from "./eval-release-evidence.mjs";
import { classifyReleaseFindingSlice } from "./eval-release-finding-classification.mjs";

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function writeCanonical(path, value) {
  writeFileSync(path, canonicalJson(value), { encoding: "utf8", mode: 0o600 });
}

function classificationFlags(verdict) {
  return {
    verdict,
    reasonCode: verdict === "false-positive"
      ? "verified-test-fixture"
      : verdict === "owner-review"
        ? "owner-review-required"
        : "remediation-required",
    matchedContentStored: false,
    credentialValidationPerformed: false,
    ownerReviewRequired: verdict === "owner-review",
    remediationRequired: verdict === "remediation-required",
  };
}

function priorClassification(release, verdict = "false-positive") {
  const findings = release.findings
    .filter((finding) => finding.ruleId === "private-key-header" && finding.scope === "candidate")
    .map(({ line, matchHash, path, ruleId }) => ({ path, line, ruleId, matchHash }))
    .sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line);
  const tupleSetHash = sha256(JSON.stringify(findings));
  const preimage = {
    archiveSha256: release.candidate.sha256,
    priorClassificationSha256: "1".repeat(64),
    releaseEvidenceSha256: "2".repeat(64),
    roadmapSha256: "3".repeat(64),
    slice: "private-key-header:candidate",
    sourceHead: release.source.head,
    sourceTree: release.source.tree,
    sourceUpstream: release.source.head,
    sourceWorktree: "clean",
    tupleSetHash,
  };
  return {
    schemaVersion: "muse.release-finding-classification/v1",
    taskId: "PA-S003",
    slice: {
      ruleId: "private-key-header",
      scope: "candidate",
      findingCount: findings.length,
    },
    status: "slice-classified",
    generatedAt: "2026-07-29T00:00:00Z",
    inputHashAlgorithm: "sha256",
    inputHashContract: "sha256(utf8(JSON.stringify(inputHashPreimage)))",
    inputHashPreimage: preimage,
    inputHash: sha256(JSON.stringify(preimage)),
    source: {
      head: release.source.head,
      tree: release.source.tree,
      upstream: release.source.head,
      worktree: "clean",
    },
    candidate: {
      archiveSha256: release.candidate.sha256,
      commit: release.candidate.commit,
      tree: release.candidate.tree,
      matchesCurrentSource: true,
    },
    bijection: {
      sourceFindingCount: findings.length,
      candidateFindingCount: findings.length,
      priorSourceFindingCount: findings.length,
      exact: true,
      tupleFields: ["path", "line", "ruleId", "matchHash"],
      tupleSetHash,
    },
    findings,
    classification: classificationFlags(verdict),
    releaseDecision: {
      gate: "red",
      classifiedInThisSlice: findings.length,
      remainingUnclassified: release.findings.length - findings.length,
      reason: "Fixture classification does not relax release gates.",
    },
    effects: {
      credentialUse: 0,
      matchedValueOutput: 0,
      network: 0,
      publication: 0,
      release: 0,
      signing: 0,
      tag: 0,
    },
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "muse-release-classification-"));
  const remote = mkdtempSync(join(tmpdir(), "muse-release-classification-remote-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "fixture@example.invalid"]);
  git(root, ["config", "user.name", "Fixture"]);
  git(remote, ["init", "--bare", "-q"]);
  const matchedValue = ["-----BEGIN ", "PRIVATE KEY-----"].join("");
  mkdirSync(join(root, "docs", "goals"), { recursive: true });
  writeFileSync(join(root, ".gitignore"), "candidate.tar\n.evidence/\n", "utf8");
  writeFileSync(
    join(root, "docs", "goals", "personal-agent-successor-roadmap.md"),
    "fixture roadmap\n",
    "utf8",
  );
  writeFileSync(join(root, "fixture.txt"), `${matchedValue}\n`, "utf8");
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "fixture"]);
  git(root, ["remote", "add", "origin", remote]);
  git(root, ["push", "-qu", "origin", "HEAD:main"]);
  const candidate = join(root, "candidate.tar");
  const evidenceDirectory = join(root, ".evidence");
  const releasePath = join(evidenceDirectory, "release.json");
  mkdirSync(evidenceDirectory, { mode: 0o700 });
  git(root, ["archive", "--format=tar", `--output=${candidate}`, "HEAD"]);
  const release = evaluateReleaseEvidence({
    candidatePath: candidate,
    outputPath: releasePath,
    repoRoot: root,
    now: () => new Date("2026-07-29T00:01:00.000Z"),
  });
  return { candidate, matchedValue, release, releasePath, remote, root };
}

test("carries forward exactly one hash-only tuple slice while keeping the release gate red", () => {
  const current = fixture();
  try {
    for (const verdict of ["false-positive", "owner-review", "remediation-required"]) {
      const priorPath = join(current.root, ".evidence", `prior-${verdict}.json`);
      const outputPath = join(current.root, ".evidence", `current-${verdict}.json`);
      writeCanonical(priorPath, priorClassification(current.release, verdict));
      const report = classifyReleaseFindingSlice({
        candidatePath: current.candidate,
        outputPath,
        priorClassificationPath: priorPath,
        releaseEvidencePath: current.releasePath,
        repoRoot: current.root,
        ruleId: "private-key-header",
        scope: "candidate",
        now: () => new Date("2026-07-29T00:02:00.000Z"),
      });

      assert.equal(report.classification.verdict, verdict);
      assert.equal(report.releaseDecision.gate, "red");
      assert.ok(report.releaseDecision.classifiedInThisSlice > 0);
      assert.ok(report.releaseDecision.remainingUnclassified > 0);
      assert.equal(report.effects.matchedValueOutput, 0);
      assert.deepEqual(JSON.parse(readFileSync(outputPath, "utf8")), report);
      assert.doesNotMatch(JSON.stringify(report), new RegExp(current.matchedValue, "u"));
      if (process.platform !== "win32") {
        assert.equal(statSync(outputPath).mode & 0o777, 0o600);
        assert.equal(statSync(join(current.root, ".evidence")).mode & 0o077, 0);
      }
    }
  } finally {
    rmSync(current.root, { force: true, recursive: true });
    rmSync(current.remote, { force: true, recursive: true });
  }
});

test("tuple, provenance, schema, source cleanliness, and filesystem drift fail closed", () => {
  const current = fixture();
  try {
    const prior = priorClassification(current.release);
    const priorPath = join(current.root, ".evidence", "prior.json");
    const outputPath = join(current.root, ".evidence", "current.json");
    writeCanonical(priorPath, prior);
    const run = (overrides = {}) => classifyReleaseFindingSlice({
      candidatePath: current.candidate,
      outputPath,
      priorClassificationPath: priorPath,
      releaseEvidencePath: current.releasePath,
      repoRoot: current.root,
      ruleId: "private-key-header",
      scope: "candidate",
      ...overrides,
    });

    const tamperedPriorPath = join(current.root, ".evidence", "prior-tampered.json");
    writeCanonical(tamperedPriorPath, { ...prior, privatePayload: "secret" });
    assert.throws(
      () => run({ priorClassificationPath: tamperedPriorPath }),
      /release-finding-classification-failed/u,
    );

    const contradictoryPath = join(current.root, ".evidence", "prior-contradictory.json");
    writeCanonical(contradictoryPath, {
      ...prior,
      classification: { ...prior.classification, verdict: "owner-review" },
    });
    assert.throws(
      () => run({ priorClassificationPath: contradictoryPath }),
      /release-finding-classification-failed/u,
    );

    const driftedPreimage = {
      ...prior.inputHashPreimage,
      sourceUpstream: "f".repeat(40),
    };
    const driftedPriorPath = join(current.root, ".evidence", "prior-drifted.json");
    writeCanonical(driftedPriorPath, {
      ...prior,
      inputHashPreimage: driftedPreimage,
      inputHash: sha256(JSON.stringify(driftedPreimage)),
    });
    assert.throws(
      () => run({ priorClassificationPath: driftedPriorPath }),
      /release-finding-classification-failed/u,
    );

    const divergentRevision = "f".repeat(40);
    const divergentPreimage = {
      ...prior.inputHashPreimage,
      sourceUpstream: divergentRevision,
    };
    const divergentPriorPath = join(current.root, ".evidence", "prior-divergent.json");
    writeCanonical(divergentPriorPath, {
      ...prior,
      inputHashPreimage: divergentPreimage,
      inputHash: sha256(JSON.stringify(divergentPreimage)),
      source: { ...prior.source, upstream: divergentRevision },
    });
    assert.throws(
      () => run({ priorClassificationPath: divergentPriorPath }),
      /release-finding-classification-failed/u,
    );

    const changedCandidateSha = "e".repeat(64);
    const candidateDriftPath = join(current.root, ".evidence", "release-candidate-drift.json");
    writeCanonical(candidateDriftPath, {
      ...current.release,
      inputHash: releaseEvidenceInputHash({
        candidateSha256: changedCandidateSha,
        sourceHead: current.release.source.head,
        sourceTree: current.release.source.tree,
      }),
      candidate: { ...current.release.candidate, sha256: changedCandidateSha },
    });
    assert.throws(
      () => run({ releaseEvidencePath: candidateDriftPath }),
      /release-finding-classification-failed/u,
    );

    const inputHashDriftPath = join(current.root, ".evidence", "release-input-hash-drift.json");
    writeCanonical(inputHashDriftPath, { ...current.release, inputHash: "f".repeat(64) });
    assert.throws(
      () => run({ releaseEvidencePath: inputHashDriftPath }),
      /release-finding-classification-failed/u,
    );

    const unpairedPath = join(current.root, ".evidence", "release-unpaired.json");
    const firstSourceIndex = current.release.findings.findIndex((finding) => (
      finding.ruleId === "private-key-header" && finding.scope === "source"
    ));
    const unpaired = {
      ...current.release,
      findings: current.release.findings.filter((_finding, index) => index !== firstSourceIndex),
    };
    writeCanonical(unpairedPath, unpaired);
    assert.throws(
      () => run({ releaseEvidencePath: unpairedPath }),
      /release-finding-classification-failed/u,
    );

    const linkedPrior = join(current.root, ".evidence", "prior-link.json");
    symlinkSync(priorPath, linkedPrior);
    assert.throws(
      () => run({ priorClassificationPath: linkedPrior }),
      /release-finding-classification-failed/u,
    );

    const linkedParent = join(current.root, ".evidence-link");
    symlinkSync(join(current.root, ".evidence"), linkedParent);
    assert.throws(
      () => run({ priorClassificationPath: join(linkedParent, "prior.json") }),
      /release-finding-classification-failed/u,
    );
    assert.throws(
      () => run({ outputPath: join(linkedParent, "redirected-output.json") }),
      /release-finding-classification-failed/u,
    );

    const victim = join(current.root, ".evidence", "victim.json");
    const linkedOutput = join(current.root, ".evidence", "linked-output.json");
    writeFileSync(victim, "preserve\n", "utf8");
    symlinkSync(victim, linkedOutput);
    assert.throws(
      () => run({ outputPath: linkedOutput }),
      /release-finding-classification-failed/u,
    );
    assert.equal(readFileSync(victim, "utf8"), "preserve\n");

    const candidateBefore = readFileSync(current.candidate);
    assert.throws(
      () => run({ outputPath: current.candidate }),
      /release-finding-classification-failed/u,
    );
    assert.deepEqual(readFileSync(current.candidate), candidateBefore);

    writeFileSync(join(current.root, "fixture.txt"), "dirty\n", "utf8");
    assert.throws(() => run(), /release-finding-classification-failed/u);
    assert.throws(
      () => run({ ruleId: "unknown-safe-rule" }),
      /release-finding-classification-failed/u,
    );
  } finally {
    rmSync(current.root, { force: true, recursive: true });
    rmSync(current.remote, { force: true, recursive: true });
  }
});
