import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
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
  bindCapabilityArtifactRoot,
  capabilityReportPath,
} from "./eval-agent-artifact-root.mjs";
import {
  beginCapabilityEvidenceAttempt,
  composeCapabilityAxisProgress as composeCapabilityAxisProgressRaw,
  createCapabilityAxisProgress as createCapabilityAxisProgressRaw,
  finalizeCapabilityEvidenceAttempt as finalizeCapabilityEvidenceAttemptRaw,
  inspectCapabilityEvidence,
  readCapabilityAxisAggregate,
  readReusableCapabilityAxisProgress,
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

function shardReceipt(value, overrides = {}, axisId) {
  const axis = axisId
    ? value.capabilities.find((row) => row.id === axisId)
    : value.capabilities.find((row) => row.reason !== "not-selected");
  if (!axis) return undefined;
  const revision = value.provenance.sourceBeforeBuild.revision;
  const runnerArtifactDigest = value.provenance.artifactsAfterBuild.digest;
  return {
    schemaVersion: 1,
    axis: axis.id,
    seed: "test-seed",
    inputHash: createHash("sha256").update(`input:${axis.id}`, "utf8").digest("hex"),
    modelIdentity: {
      embedding: "test-embed:1",
      generation: "test-generate:1",
    },
    runtimeIdentity: {
      node: "v24.0.0",
      platform: "darwin/arm64",
      runnerArtifactDigest,
    },
    source: { revision, tree: "clean" },
    ...overrides,
  };
}

function shardReceipts(value, overridesByAxis = {}) {
  return CAPABILITIES.map((capability) => shardReceipt(
    value,
    overridesByAxis[capability.id] ?? {},
    capability.id,
  ));
}

function createCapabilityAxisProgress(value, overrides) {
  return createCapabilityAxisProgressRaw(value, shardReceipt(value, overrides));
}

function composeCapabilityAxisProgress(current, prior, overrides, overridesByAxis) {
  return composeCapabilityAxisProgressRaw(
    current,
    prior,
    shardReceipt(current, overrides),
    shardReceipts(current, overridesByAxis),
  );
}

function finalizeCapabilityEvidenceAttempt(attempt, value, options = {}) {
  const selected = value?.capabilities?.filter((row) => row.reason !== "not-selected") ?? [];
  return finalizeCapabilityEvidenceAttemptRaw(attempt, value, {
    ...options,
    ...(selected.length === 1 ? {
      shardReceipt: shardReceipt(value),
      shardReceipts: shardReceipts(value),
    } : {}),
  });
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function writeCanonicalJson(path, value) {
  writeFileSync(path, canonicalJson(value), { encoding: "utf8", mode: 0o600 });
}

function writeLegacyV1AxisProgress(root, axisId = "plan-quality") {
  const attemptId = "11111111-1111-4111-8111-111111111111";
  const directory = join(root, "evals", "agent-capability");
  const attempts = join(directory, "attempts");
  const progressDirectory = join(directory, "axis-progress");
  mkdirSync(attempts, { mode: 0o700, recursive: true });
  mkdirSync(progressDirectory, { mode: 0o700, recursive: true });
  if (process.platform !== "win32") {
    chmodSync(directory, 0o700);
    chmodSync(attempts, 0o700);
    chmodSync(progressDirectory, 0o700);
  }

  const legacy = structuredClone(singleAxisReport(
    axisId,
    "passed",
    "2026-07-21T00:00:00.000Z",
  ));
  legacy.matrixId = "muse-agent-capability-v1";
  legacy.capabilities.find((row) => row.id === "cosine-recall-abstention").requested = 1;
  const reportText = canonicalJson(legacy);
  const reportSha256 = sha256(reportText);
  const reportPath = join(attempts, `${attemptId}.report.json`);
  writeFileSync(reportPath, reportText, { encoding: "utf8", mode: 0o600 });
  writeCanonicalJson(join(attempts, `${attemptId}.state.json`), {
    schemaVersion: 1,
    attemptId,
    phase: "completed",
    status: "unverified",
    reportSha256,
  });
  const axis = legacy.capabilities.find((row) => row.id === axisId);
  writeCanonicalJson(join(progressDirectory, `${axisId}.json`), {
    schemaVersion: 1,
    attemptId,
    reportSha256,
    progress: {
      schemaVersion: 1,
      matrixId: "muse-agent-capability-v1",
      generatedAt: legacy.generatedAt,
      axis,
      provenance: legacy.provenance,
    },
  });
  return { reportPath };
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

test("axis progress rejects any missing source, input, seed, model, or runtime receipt field", () => {
  const value = singleAxisReport(
    "plan-quality",
    "passed",
    "2026-07-21T00:00:00.000Z",
  );
  const receipt = shardReceipt(value);
  assert.equal(createCapabilityAxisProgressRaw(value, undefined), undefined);
  for (const key of [
    "axis",
    "inputHash",
    "modelIdentity",
    "runtimeIdentity",
    "seed",
    "source",
  ]) {
    const missing = structuredClone(receipt);
    delete missing[key];
    assert.equal(createCapabilityAxisProgressRaw(value, missing), undefined, key);
  }
  assert.equal(createCapabilityAxisProgressRaw(value, {
    ...receipt,
    source: { revision: receipt.source.revision },
  }), undefined);
  assert.equal(createCapabilityAxisProgressRaw(value, {
    ...receipt,
    source: { ...receipt.source, revision: "c".repeat(40) },
  }), undefined);
  assert.equal(createCapabilityAxisProgressRaw(value, {
    ...receipt,
    modelIdentity: { generation: receipt.modelIdentity.generation },
  }), undefined);
  assert.equal(createCapabilityAxisProgressRaw(value, {
    ...receipt,
    runtimeIdentity: { ...receipt.runtimeIdentity, runnerArtifactDigest: "c".repeat(64) },
  }), undefined);
  assert.equal(createCapabilityAxisProgressRaw(value, {
    ...receipt,
    modelIdentity: { ...receipt.modelIdentity, generation: "sk-secret-like-value" },
  }), undefined);
});

test("receipt mismatch stales only that prior axis instead of reusing it", () => {
  const planReport = singleAxisReport(
    "plan-quality",
    "passed",
    "2026-07-21T00:00:00.000Z",
  );
  const toolReport = singleAxisReport(
    "tool-selection-arguments",
    "passed",
    "2026-07-21T00:05:00.000Z",
  );
  const plan = createCapabilityAxisProgress(planReport);
  const changedInput = "c".repeat(64);
  const aggregate = composeCapabilityAxisProgress(
    toolReport,
    [plan],
    undefined,
    { "plan-quality": { inputHash: changedInput } },
  );
  assert.deepEqual(aggregate.counts, { failed: 0, passed: 1, total: 11, unverified: 10 });
  assert.equal(aggregate.capabilities.find((row) => row.id === "plan-quality").reason, "not-selected");
  assert.equal(
    aggregate.capabilities.find((row) => row.id === "tool-selection-arguments").status,
    "passed",
  );
});

test("authenticated v1 progress is obsolete and ignored while a tampered legacy chain still fails closed", () => {
  const { root, reportPath } = fixture();
  try {
    const legacy = writeLegacyV1AxisProgress(root);
    const current = beginCapabilityEvidenceAttempt({ allowedRoot: root, reportPath });
    const finalized = finalizeCapabilityEvidenceAttempt(current, singleAxisReport(
      "cosine-recall-abstention",
      "passed",
      "2026-07-21T00:05:00.000Z",
    ));
    assert.deepEqual(finalized.counts, { failed: 0, passed: 1, total: 11, unverified: 10 });
    assert.equal(
      finalized.capabilities.find((row) => row.id === "plan-quality").reason,
      "not-selected",
    );
    assert.equal(
      finalized.capabilities.find((row) => row.id === "cosine-recall-abstention").status,
      "passed",
    );

    writeFileSync(legacy.reportPath, `${readFileSync(legacy.reportPath, "utf8")}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    const next = beginCapabilityEvidenceAttempt({ allowedRoot: root, reportPath });
    assert.throws(
      () => finalizeCapabilityEvidenceAttempt(next, singleAxisReport(
        "tool-selection-arguments",
        "passed",
        "2026-07-21T00:10:00.000Z",
      )),
      /capability-report-persistence-failed/u,
    );
    assert.equal(inspectCapabilityEvidence({ allowedRoot: root, reportPath }).state, "running");
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("an unknown matrix id in axis progress remains fail closed", () => {
  const { root, reportPath } = fixture();
  try {
    writeLegacyV1AxisProgress(root);
    const progressPath = join(root, "evals", "agent-capability", "axis-progress", "plan-quality.json");
    const record = JSON.parse(readFileSync(progressPath, "utf8"));
    record.progress.matrixId = "muse-agent-capability-v999";
    writeCanonicalJson(progressPath, record);

    const current = beginCapabilityEvidenceAttempt({ allowedRoot: root, reportPath });
    assert.throws(
      () => finalizeCapabilityEvidenceAttempt(current, singleAxisReport(
        "cosine-recall-abstention",
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

test("only an exact authenticated completed receipt is reusable", () => {
  const { root, reportPath } = fixture();
  try {
    const value = singleAxisReport(
      "plan-quality",
      "passed",
      "2026-07-21T00:00:00.000Z",
    );
    const attempt = beginCapabilityEvidenceAttempt({ allowedRoot: root, reportPath });
    finalizeCapabilityEvidenceAttempt(attempt, value);
    const exact = shardReceipt(value);
    const reused = readReusableCapabilityAxisProgress({
      allowedRoot: root,
      axisId: "plan-quality",
      expectedReceipt: exact,
      reportPath,
    });
    assert.equal(reused.axis.id, "plan-quality");
    assert.equal(reused.axis.status, "passed");

    for (const changed of [
      { ...exact, seed: "18" },
      { ...exact, inputHash: "c".repeat(64) },
      {
        ...exact,
        modelIdentity: { ...exact.modelIdentity, generation: "other-model:1" },
      },
      {
        ...exact,
        runtimeIdentity: { ...exact.runtimeIdentity, node: "v25.0.0" },
      },
      {
        ...exact,
        source: { ...exact.source, revision: "c".repeat(40) },
      },
    ]) {
      assert.equal(readReusableCapabilityAxisProgress({
        allowedRoot: root,
        axisId: "plan-quality",
        expectedReceipt: changed,
        reportPath,
      }), undefined);
    }
    assert.equal(readReusableCapabilityAxisProgress({
      allowedRoot: root,
      axisId: "tool-selection-arguments",
      expectedReceipt: exact,
      reportPath,
    }), undefined);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

test("cached aggregate is read-only and stale or missing required shards cannot become green", () => {
  const { root, reportPath } = fixture();
  try {
    const planReport = singleAxisReport(
      "plan-quality",
      "passed",
      "2026-07-21T00:00:00.000Z",
    );
    const planAttempt = beginCapabilityEvidenceAttempt({ allowedRoot: root, reportPath });
    finalizeCapabilityEvidenceAttempt(planAttempt, planReport);
    const toolReport = singleAxisReport(
      "tool-selection-arguments",
      "passed",
      "2026-07-21T00:05:00.000Z",
    );
    const toolAttempt = beginCapabilityEvidenceAttempt({ allowedRoot: root, reportPath });
    finalizeCapabilityEvidenceAttempt(toolAttempt, toolReport);

    const progressDirectory = join(root, "evals", "agent-capability", "axis-progress");
    const before = new Map(readdirSync(progressDirectory).map((name) => [
      name,
      readFileSync(join(progressDirectory, name), "utf8"),
    ]));
    const aggregate = readCapabilityAxisAggregate({
      allowedRoot: root,
      expectedReceipts: shardReceipts(toolReport),
      generatedAt: "2026-07-21T00:10:00.000Z",
      provenance: toolReport.provenance,
      reportPath,
    });
    assert.equal(aggregate.status, "unverified");
    assert.deepEqual(aggregate.counts, { failed: 0, passed: 2, total: 11, unverified: 9 });
    assert.equal(aggregate.capabilities.find((row) => row.id === "plan-quality").status, "passed");
    assert.equal(
      aggregate.capabilities.find((row) => row.id === "tool-argument-grounding").reason,
      "not-selected",
    );
    const after = new Map(readdirSync(progressDirectory).map((name) => [
      name,
      readFileSync(join(progressDirectory, name), "utf8"),
    ]));
    assert.deepEqual(after, before);

    const stalePlanReceipts = shardReceipts(toolReport, {
      "plan-quality": { inputHash: "c".repeat(64) },
    });
    const stale = readCapabilityAxisAggregate({
      allowedRoot: root,
      expectedReceipts: stalePlanReceipts,
      provenance: toolReport.provenance,
      reportPath,
    });
    assert.equal(stale.status, "unverified");
    assert.deepEqual(stale.counts, { failed: 0, passed: 1, total: 11, unverified: 10 });
    assert.equal(stale.capabilities.find((row) => row.id === "plan-quality").reason, "not-selected");

    const duplicateReceipts = shardReceipts(toolReport);
    duplicateReceipts[1] = duplicateReceipts[0];
    assert.equal(readCapabilityAxisAggregate({
      allowedRoot: root,
      expectedReceipts: duplicateReceipts,
      provenance: toolReport.provenance,
      reportPath,
    }), undefined);
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

test("a receipt mutation is rejected by the completed attempt state binding", () => {
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
    value.progress.shardReceipt.seed = "18";
    writeCanonicalJson(progressPath, value);

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

test("bound production evidence rejects root replacement before committing any external file", () => {
  if (process.platform === "win32") return;
  const fixtureRoot = realpathSync(mkdtempSync(join(tmpdir(), "muse-bound-evidence-")));
  const repoRoot = join(fixtureRoot, "repo");
  const artifactRoot = join(fixtureRoot, "artifacts");
  const movedRoot = join(fixtureRoot, "moved-artifacts");
  const outside = join(fixtureRoot, "outside");
  mkdirSync(repoRoot);
  mkdirSync(artifactRoot);
  mkdirSync(outside);
  const binding = bindCapabilityArtifactRoot(repoRoot, artifactRoot);
  const reportPath = capabilityReportPath(binding);
  let swapped = false;
  try {
    assert.throws(
      () => beginCapabilityEvidenceAttempt({
        allowedRoot: artifactRoot,
        allowedRootBinding: binding,
        beforeCommit: () => {
          if (swapped) return;
          swapped = true;
          renameSync(artifactRoot, movedRoot);
          symlinkSync(outside, artifactRoot, "dir");
        },
        reportPath,
      }),
      /capability-report-persistence-failed/u,
    );
    assert.deepEqual(readdirSync(outside), []);
  } finally {
    rmSync(fixtureRoot, { force: true, recursive: true });
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
