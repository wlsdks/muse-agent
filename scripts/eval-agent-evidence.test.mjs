import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CAPABILITIES, createCapabilityReport } from "./eval-agent.mjs";
import {
  beginCapabilityEvidenceAttempt,
  finalizeCapabilityEvidenceAttempt,
  inspectCapabilityEvidence,
} from "./eval-agent-evidence.mjs";

function rows(status = "passed", reason = "runtime-execution-failed") {
  return CAPABILITIES.map((capability) => ({
    durationMs: 1,
    executed: status === "passed" ? capability.repeats : 0,
    id: capability.id,
    requested: capability.repeats,
    required: capability.required,
    status,
    ...(status === "passed" ? {} : { reason }),
  }));
}

function report(status = "passed") {
  const source = { revision: "a".repeat(40), tree: "clean" };
  const artifacts = { count: 41, digest: "b".repeat(64), status: "ok" };
  return createCapabilityReport(rows(status), {
    generatedAt: "2026-07-21T00:00:00.000Z",
    provenance: {
      sourceBeforeBuild: source,
      sourceAfterBuild: source,
      sourceAtEnd: source,
      artifactsAfterBuild: artifacts,
      artifactsAtEnd: artifacts,
    },
  });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "muse-capability-evidence-"));
  return { root, reportPath: join(root, "evals", "agent-capability", "latest.json") };
}

test("running, completed pass, and owner-only immutable generation states are inspectable", () => {
  const { root, reportPath } = fixture();
  try {
    const attempt = beginCapabilityEvidenceAttempt({ allowedRoot: root, reportPath });
    assert.equal(inspectCapabilityEvidence({ allowedRoot: root, reportPath }).state, "running");
    finalizeCapabilityEvidenceAttempt(attempt, report());
    const inspected = inspectCapabilityEvidence({ allowedRoot: root, reportPath });
    assert.equal(inspected.state, "completed");
    assert.equal(inspected.status, "passed");
    assert.equal(inspected.artifact.value.status, "passed");
    if (process.platform !== "win32") {
      assert.equal(statSync(reportPath).mode & 0o777, 0o600);
      assert.equal(statSync(join(root, "evals", "agent-capability", "latest-attempt.json")).mode & 0o777, 0o600);
      assert.equal(statSync(join(root, "evals", "agent-capability", "attempts")).mode & 0o077, 0);
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("completed failure remains terminal evidence and never creates a canonical report", () => {
  const { root, reportPath } = fixture();
  try {
    const attempt = beginCapabilityEvidenceAttempt({ allowedRoot: root, reportPath });
    finalizeCapabilityEvidenceAttempt(attempt, report("failed"));
    const inspected = inspectCapabilityEvidence({ allowedRoot: root, reportPath });
    assert.equal(inspected.state, "completed");
    assert.equal(inspected.status, "failed");
    assert.equal(inspected.artifact.value.status, "failed");
    assert.equal(statSync(join(root, "evals", "agent-capability", "attempts", `${attempt.attemptId}.report.json`)).isFile(), true);
    assert.throws(() => statSync(reportPath), { code: "ENOENT" });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a superseded concurrent attempt cannot finalize or overwrite the current pointer", () => {
  const { root, reportPath } = fixture();
  try {
    const older = beginCapabilityEvidenceAttempt({ allowedRoot: root, reportPath });
    const current = beginCapabilityEvidenceAttempt({ allowedRoot: root, reportPath });
    assert.throws(
      () => finalizeCapabilityEvidenceAttempt(older, report()),
      /capability-report-persistence-failed/u,
    );
    assert.equal(inspectCapabilityEvidence({ allowedRoot: root, reportPath }).state, "running");
    finalizeCapabilityEvidenceAttempt(current, report());
    assert.equal(inspectCapabilityEvidence({ allowedRoot: root, reportPath }).status, "passed");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("duplicate-key pointer JSON and changed terminal report bytes fail closed", () => {
  const { root, reportPath } = fixture();
  try {
    const attempt = beginCapabilityEvidenceAttempt({ allowedRoot: root, reportPath });
    const pointer = join(root, "evals", "agent-capability", "latest-attempt.json");
    writeFileSync(pointer, `{"schemaVersion":1,"attemptId":"${attempt.attemptId}","attemptId":"${attempt.attemptId}"}\n`, { mode: 0o600 });
    if (process.platform !== "win32") chmodSync(pointer, 0o600);
    assert.equal(inspectCapabilityEvidence({ allowedRoot: root, reportPath }).state, "invalid");

    const replacement = beginCapabilityEvidenceAttempt({ allowedRoot: root, reportPath });
    finalizeCapabilityEvidenceAttempt(replacement, report());
    const terminal = join(root, "evals", "agent-capability", "attempts", `${replacement.attemptId}.report.json`);
    writeFileSync(terminal, `${readFileSync(terminal, "utf8")}\n`, { mode: 0o600 });
    if (process.platform !== "win32") chmodSync(terminal, 0o600);
    assert.equal(inspectCapabilityEvidence({ allowedRoot: root, reportPath }).state, "invalid");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("noncanonical or incomplete v2 reports can never be promoted", () => {
  const { root, reportPath } = fixture();
  try {
    const attempt = beginCapabilityEvidenceAttempt({ allowedRoot: root, reportPath });
    assert.throws(
      () => finalizeCapabilityEvidenceAttempt(attempt, { ...report(), capabilities: [] }),
      /capability-report-persistence-failed/u,
    );
    assert.equal(inspectCapabilityEvidence({ allowedRoot: root, reportPath }).state, "running");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a post-rename canonical directory-fsync failure restores prior bytes and leaves the new attempt running", () => {
  if (process.platform === "win32") return;
  const { root, reportPath } = fixture();
  try {
    const priorAttempt = beginCapabilityEvidenceAttempt({ allowedRoot: root, reportPath });
    finalizeCapabilityEvidenceAttempt(priorAttempt, report());
    const priorBytes = readFileSync(reportPath, "utf8");

    let syncs = 0;
    const failAt = 20;
    const fsync = () => {
      syncs += 1;
      if (syncs === failAt) throw new Error("fsync failed");
    };
    const current = beginCapabilityEvidenceAttempt({ allowedRoot: root, fsync, reportPath });
    assert.throws(
      () => finalizeCapabilityEvidenceAttempt(current, report(), { fsync }),
      /capability-report-persistence-failed/u,
    );
    assert.equal(readFileSync(reportPath, "utf8"), priorBytes);
    assert.equal(inspectCapabilityEvidence({ allowedRoot: root, reportPath }).state, "running");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a post-rename completed-state directory-fsync failure restores running state", () => {
  if (process.platform === "win32") return;
  const { root, reportPath } = fixture();
  try {
    let syncs = 0;
    const fsync = () => {
      syncs += 1;
      if (syncs === 25) throw new Error("state directory fsync failed");
    };
    const attempt = beginCapabilityEvidenceAttempt({ allowedRoot: root, fsync, reportPath });
    assert.throws(
      () => finalizeCapabilityEvidenceAttempt(attempt, report(), { fsync }),
      /capability-report-persistence-failed/u,
    );
    const inspected = inspectCapabilityEvidence({ allowedRoot: root, reportPath });
    assert.equal(inspected.state, "running");
    assert.notEqual(inspected.status, "passed");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});
