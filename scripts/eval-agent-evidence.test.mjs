import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CAPABILITIES, createCapabilityReport } from "./eval-agent.mjs";
import {
  beginCapabilityEvidenceAttempt,
  composeCapabilityAxisProgress,
  createCapabilityAxisProgress,
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

function singleAxisReport(
  axisId,
  status,
  generatedAt,
  { digest = "b".repeat(64), revision = "a".repeat(40) } = {},
) {
  const source = { revision, tree: "clean" };
  const artifacts = { count: 41, digest, status: "ok" };
  const capabilities = CAPABILITIES.map((capability) => capability.id === axisId
    ? {
      durationMs: 10,
      executed: status === "passed" ? capability.repeats : 0,
      id: capability.id,
      requested: capability.repeats,
      required: capability.required,
      status,
      ...(status === "passed" ? {} : { reason: "threshold-not-met" }),
    }
    : {
      durationMs: 0,
      executed: 0,
      id: capability.id,
      reason: "not-selected",
      requested: capability.repeats,
      required: capability.required,
      status: "unverified",
    });
  return createCapabilityReport(capabilities, {
    generatedAt,
    provenance: {
      sourceBeforeBuild: source,
      sourceAfterBuild: source,
      sourceAtEnd: source,
      artifactsAfterBuild: artifacts,
      artifactsAtEnd: artifacts,
    },
  });
}

test("axis progress composes only exact same-provenance rows and keeps the oldest evidence time", () => {
  const plan = createCapabilityAxisProgress(singleAxisReport(
    "plan-quality",
    "passed",
    "2026-07-21T00:00:00.000Z",
  ));
  const current = singleAxisReport(
    "tool-selection-arguments",
    "passed",
    "2026-07-21T00:05:00.000Z",
  );
  const aggregate = composeCapabilityAxisProgress(current, [plan]);

  assert.equal(aggregate.status, "unverified");
  assert.deepEqual(aggregate.counts, { failed: 0, passed: 2, total: 11, unverified: 9 });
  assert.equal(aggregate.generatedAt, "2026-07-21T00:00:00.000Z");
  assert.equal(aggregate.capabilities.find((row) => row.id === "plan-quality").status, "passed");
  assert.equal(aggregate.capabilities.find((row) => row.id === "tool-selection-arguments").status, "passed");

  const otherHead = createCapabilityAxisProgress(singleAxisReport(
    "tool-argument-grounding",
    "passed",
    "2026-07-21T00:01:00.000Z",
    { revision: "c".repeat(40) },
  ));
  assert.deepEqual(composeCapabilityAxisProgress(current, [otherHead]), current);
  const otherArtifacts = createCapabilityAxisProgress(singleAxisReport(
    "tool-argument-grounding",
    "passed",
    "2026-07-21T00:01:00.000Z",
    { digest: "d".repeat(64) },
  ));
  assert.deepEqual(composeCapabilityAxisProgress(current, [otherArtifacts]), current);
});

test("newer axis evidence replaces an older result while malformed, tied, or future progress fails closed", () => {
  const oldPass = createCapabilityAxisProgress(singleAxisReport(
    "plan-quality",
    "passed",
    "2026-07-21T00:00:00.000Z",
  ));
  const currentFailure = singleAxisReport(
    "plan-quality",
    "failed",
    "2026-07-21T00:05:00.000Z",
  );
  const replaced = composeCapabilityAxisProgress(currentFailure, [oldPass]);
  assert.equal(replaced.status, "failed");
  assert.equal(replaced.capabilities.find((row) => row.id === "plan-quality").reason, "threshold-not-met");

  const current = singleAxisReport(
    "tool-selection-arguments",
    "passed",
    "2026-07-21T00:05:00.000Z",
  );
  assert.equal(composeCapabilityAxisProgress(current, [{ ...oldPass, privatePayload: "secret" }]), undefined);
  assert.equal(composeCapabilityAxisProgress(current, [{
    ...oldPass,
    axis: { ...oldPass.axis, status: "failed", reason: "/Users/private-owner/secret" },
  }]), undefined);
  assert.equal(composeCapabilityAxisProgress(current, [{
    ...oldPass,
    axis: { ...oldPass.axis, executed: 0, status: "failed", reason: "not-selected" },
  }]), undefined);
  assert.equal(composeCapabilityAxisProgress(current, [{ ...oldPass, generatedAt: "2026-07-21T00:06:00.000Z" }]), undefined);
  assert.equal(composeCapabilityAxisProgress(current, [
    oldPass,
    { ...oldPass, axis: { ...oldPass.axis, durationMs: 11 } },
  ]), undefined);

  const mutatedPlaceholder = structuredClone(current);
  const placeholder = mutatedPlaceholder.capabilities.find((row) => row.id === "plan-quality");
  placeholder.executed = 3;
  placeholder.durationMs = 999;
  assert.equal(createCapabilityAxisProgress(mutatedPlaceholder), undefined);

  const selectedNotSelected = structuredClone(current);
  const selected = selectedNotSelected.capabilities.find((row) => row.id === "tool-selection-arguments");
  selected.status = "failed";
  selected.executed = 0;
  selected.reason = "not-selected";
  selectedNotSelected.counts = { failed: 1, passed: 0, total: 11, unverified: 10 };
  selectedNotSelected.status = "failed";
  assert.equal(createCapabilityAxisProgress(selectedNotSelected), undefined);
});

test("nine same-provenance required-axis passes produce a passing aggregate without optional overclaim", () => {
  const required = CAPABILITIES.filter((capability) => capability.required);
  const reports = required.map((capability, index) => singleAxisReport(
    capability.id,
    "passed",
    `2026-07-21T00:${index.toString().padStart(2, "0")}:00.000Z`,
  ));
  const current = reports.at(-1);
  const prior = reports.slice(0, -1).map((value) => createCapabilityAxisProgress(value));
  const aggregate = composeCapabilityAxisProgress(current, prior);

  assert.equal(aggregate.status, "passed");
  assert.deepEqual(aggregate.counts, { failed: 0, passed: 9, total: 11, unverified: 2 });
  assert.equal(aggregate.generatedAt, "2026-07-21T00:00:00.000Z");
  assert.ok(aggregate.capabilities.slice(0, 9).every((row) => row.status === "passed"));
  assert.ok(aggregate.capabilities.slice(9).every((row) => (
    row.status === "unverified" && row.reason === "not-selected"
  )));
});

test("owner-only axis progress persists and composes across completed same-provenance attempts", () => {
  const { root, reportPath } = fixture();
  try {
    const planAttempt = beginCapabilityEvidenceAttempt({ allowedRoot: root, reportPath });
    const plan = finalizeCapabilityEvidenceAttempt(planAttempt, singleAxisReport(
      "plan-quality",
      "passed",
      "2026-07-21T00:00:00.000Z",
    ));
    assert.deepEqual(plan.counts, { failed: 0, passed: 1, total: 11, unverified: 10 });

    const toolAttempt = beginCapabilityEvidenceAttempt({ allowedRoot: root, reportPath });
    const aggregate = finalizeCapabilityEvidenceAttempt(toolAttempt, singleAxisReport(
      "tool-selection-arguments",
      "passed",
      "2026-07-21T00:05:00.000Z",
    ));
    assert.deepEqual(aggregate.counts, { failed: 0, passed: 2, total: 11, unverified: 9 });
    assert.equal(aggregate.generatedAt, "2026-07-21T00:00:00.000Z");

    const inspected = inspectCapabilityEvidence({ allowedRoot: root, reportPath });
    assert.equal(inspected.status, "unverified");
    assert.deepEqual(inspected.artifact.value, aggregate);
    assert.throws(() => statSync(reportPath), { code: "ENOENT" });
    if (process.platform !== "win32") {
      const progressRoot = join(root, "evals", "agent-capability", "axis-progress");
      assert.equal(statSync(progressRoot).mode & 0o077, 0);
      assert.equal(statSync(join(progressRoot, "plan-quality.json")).mode & 0o777, 0o600);
      assert.equal(statSync(join(progressRoot, "tool-selection-arguments.json")).mode & 0o777, 0o600);
    }
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("only a persisted aggregate with all required axes promotes the canonical report", () => {
  const { root, reportPath } = fixture();
  try {
    const required = CAPABILITIES.filter((capability) => capability.required);
    let aggregate;
    for (let index = 0; index < required.length; index += 1) {
      const attempt = beginCapabilityEvidenceAttempt({ allowedRoot: root, reportPath });
      aggregate = finalizeCapabilityEvidenceAttempt(attempt, singleAxisReport(
        required[index].id,
        "passed",
        `2026-07-21T00:${index.toString().padStart(2, "0")}:00.000Z`,
      ));
      if (index < required.length - 1) {
        assert.equal(aggregate.status, "unverified");
        assert.throws(() => statSync(reportPath), { code: "ENOENT" });
      }
    }
    assert.equal(aggregate.status, "passed");
    assert.deepEqual(aggregate.counts, { failed: 0, passed: 9, total: 11, unverified: 2 });
    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), aggregate);
    assert.equal(inspectCapabilityEvidence({ allowedRoot: root, reportPath }).status, "passed");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("a newer axis failure replaces its prior pass and provenance drift cannot reuse checkpoints", () => {
  const { root, reportPath } = fixture();
  try {
    const first = beginCapabilityEvidenceAttempt({ allowedRoot: root, reportPath });
    finalizeCapabilityEvidenceAttempt(first, singleAxisReport(
      "plan-quality",
      "passed",
      "2026-07-21T00:00:00.000Z",
    ));

    const failure = beginCapabilityEvidenceAttempt({ allowedRoot: root, reportPath });
    const failed = finalizeCapabilityEvidenceAttempt(failure, singleAxisReport(
      "plan-quality",
      "failed",
      "2026-07-21T00:05:00.000Z",
    ));
    assert.equal(failed.status, "failed");
    assert.equal(failed.capabilities.find((row) => row.id === "plan-quality").reason, "threshold-not-met");

    const drifted = beginCapabilityEvidenceAttempt({ allowedRoot: root, reportPath });
    const isolated = finalizeCapabilityEvidenceAttempt(drifted, singleAxisReport(
      "tool-selection-arguments",
      "passed",
      "2026-07-21T00:10:00.000Z",
      { revision: "c".repeat(40) },
    ));
    assert.deepEqual(isolated.counts, { failed: 0, passed: 1, total: 11, unverified: 10 });
    assert.equal(isolated.capabilities.find((row) => row.id === "plan-quality").reason, "not-selected");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("tampered axis progress blocks composition and leaves the current attempt running", () => {
  const { root, reportPath } = fixture();
  try {
    const first = beginCapabilityEvidenceAttempt({ allowedRoot: root, reportPath });
    finalizeCapabilityEvidenceAttempt(first, singleAxisReport(
      "plan-quality",
      "passed",
      "2026-07-21T00:00:00.000Z",
    ));
    const progressPath = join(root, "evals", "agent-capability", "axis-progress", "plan-quality.json");
    const value = JSON.parse(readFileSync(progressPath, "utf8"));
    writeFileSync(progressPath, `${JSON.stringify({ ...value, privatePayload: "secret" }, null, 2)}\n`, { mode: 0o600 });

    const current = beginCapabilityEvidenceAttempt({ allowedRoot: root, reportPath });
    assert.throws(
      () => finalizeCapabilityEvidenceAttempt(current, singleAxisReport(
        "tool-selection-arguments",
        "passed",
        "2026-07-21T00:05:00.000Z",
      )),
      /capability-report-persistence-failed/u,
    );
    assert.equal(inspectCapabilityEvidence({ allowedRoot: root, reportPath }).state, "running");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("unexpected axis progress entries fail closed", () => {
  const { root, reportPath } = fixture();
  try {
    const first = beginCapabilityEvidenceAttempt({ allowedRoot: root, reportPath });
    finalizeCapabilityEvidenceAttempt(first, singleAxisReport(
      "plan-quality",
      "passed",
      "2026-07-21T00:00:00.000Z",
    ));
    writeFileSync(
      join(root, "evals", "agent-capability", "axis-progress", "unexpected.json"),
      "{}\n",
      { mode: 0o600 },
    );

    const current = beginCapabilityEvidenceAttempt({ allowedRoot: root, reportPath });
    assert.throws(
      () => finalizeCapabilityEvidenceAttempt(current, singleAxisReport(
        "tool-selection-arguments",
        "passed",
        "2026-07-21T00:05:00.000Z",
      )),
      /capability-report-persistence-failed/u,
    );
    assert.equal(inspectCapabilityEvidence({ allowedRoot: root, reportPath }).state, "running");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("axis progress cannot be redirected through a symlinked parent", () => {
  const { root, reportPath } = fixture();
  const outside = mkdtempSync(join(tmpdir(), "muse-capability-progress-outside-"));
  try {
    const attempt = beginCapabilityEvidenceAttempt({ allowedRoot: root, reportPath });
    const directory = join(root, "evals", "agent-capability");
    mkdirSync(directory, { recursive: true });
    symlinkSync(outside, join(directory, "axis-progress"), "dir");
    assert.throws(
      () => finalizeCapabilityEvidenceAttempt(attempt, singleAxisReport(
        "plan-quality",
        "passed",
        "2026-07-21T00:00:00.000Z",
      )),
      /capability-report-persistence-failed/u,
    );
    assert.deepEqual(readdirSync(outside), []);
  } finally {
    rmSync(root, { force: true, recursive: true });
    rmSync(outside, { force: true, recursive: true });
  }
});

test("a checkpoint that references an incomplete attempt is ignored and cannot become green evidence", () => {
  const { root, reportPath } = fixture();
  try {
    const completed = beginCapabilityEvidenceAttempt({ allowedRoot: root, reportPath });
    finalizeCapabilityEvidenceAttempt(completed, singleAxisReport(
      "plan-quality",
      "passed",
      "2026-07-21T00:00:00.000Z",
    ));
    const pending = beginCapabilityEvidenceAttempt({ allowedRoot: root, reportPath });
    const progressPath = join(root, "evals", "agent-capability", "axis-progress", "plan-quality.json");
    const progress = JSON.parse(readFileSync(progressPath, "utf8"));
    writeFileSync(progressPath, `${JSON.stringify({ ...progress, attemptId: pending.attemptId }, null, 2)}\n`, {
      mode: 0o600,
    });

    const current = beginCapabilityEvidenceAttempt({ allowedRoot: root, reportPath });
    const aggregate = finalizeCapabilityEvidenceAttempt(current, singleAxisReport(
      "tool-selection-arguments",
      "passed",
      "2026-07-21T00:05:00.000Z",
    ));
    assert.deepEqual(aggregate.counts, { failed: 0, passed: 1, total: 11, unverified: 10 });
    assert.equal(aggregate.capabilities.find((row) => row.id === "plan-quality").reason, "not-selected");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

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
