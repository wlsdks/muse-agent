import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  CAPABILITIES,
  classifyCapabilityResult,
  createCapabilityExecutionAdmissionForArgs,
  createCapabilityPreflight,
  createCapabilityReport,
  createCapabilityShardReceipt,
  main,
  persistCapabilityReport,
  selectCapabilityAxes,
} from "./eval-agent.mjs";
import {
  beginCapabilityEvidenceAttempt,
  finalizeCapabilityEvidenceAttempt,
  inspectCapabilityEvidence,
} from "./eval-agent-evidence.mjs";
import { RECALL_QUALITY_MIN_REPEAT } from "./eval-recall-quality.mjs";
import { completionLine, skipLine } from "./eval-skip.mjs";

const stochastic = CAPABILITIES[0];
const EXECUTE_ARGS = ["--execute", "--confirm-idle", "--budget-minutes", "132"];
const HEALTHY_RESOURCE_SNAPSHOT = {
  cpuCount: 8,
  freeMemoryBytes: 8 * 1024 * 1024 * 1024,
  load1: 1,
};

function result(stdout, overrides = {}) {
  return {
    status: 0,
    signal: null,
    error: undefined,
    stdout,
    stderr: "",
    durationMs: 17,
    ...overrides,
  };
}

function verifiedPipeline(overrides = {}) {
  return {
    buildRunnerArtifact: () => ({ ok: true, runnerPath: "/fixed/private/muse-runner" }),
    captureArtifacts: () => ({ count: 41, digest: "a".repeat(64), status: "ok" }),
    captureSource: () => ({ revision: "a".repeat(40), tree: "clean" }),
    readResourceSnapshot: () => HEALTHY_RESOURCE_SNAPSHOT,
    runTypeScriptBuild: () => ({ ok: true }),
    ...overrides,
  };
}

function passingRows() {
  return CAPABILITIES.map((capability) => ({
    durationMs: 1,
    executed: capability.repeats,
    id: capability.id,
    requested: capability.repeats,
    required: capability.required,
    status: "passed",
  }));
}

function passingReport() {
  const source = { revision: "a".repeat(40), tree: "clean" };
  const artifacts = { count: 41, digest: "b".repeat(64), status: "ok" };
  return createCapabilityReport(passingRows(), {
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

function writeOwnerJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

test("capability matrix is stable, ordered, and uses strict pass^3 where required", () => {
  assert.deepEqual(
    CAPABILITIES.map(({ id, required, repeats }) => ({ id, required, repeats })),
    [
      { id: "tool-selection-arguments", required: true, repeats: 3 },
      { id: "plan-quality", required: true, repeats: 3 },
      { id: "tool-argument-grounding", required: true, repeats: 3 },
      { id: "computer-task-terminal-edit", required: true, repeats: 3 },
      { id: "adversarial-containment-no-op", required: true, repeats: 3 },
      { id: "cosine-recall-abstention", required: true, repeats: 3 },
      { id: "multihop-retrieval-lift", required: true, repeats: 1 },
      { id: "orchestration-failure-bounds", required: true, repeats: 3 },
      { id: "channel-conversation-rhythm", required: true, repeats: 3 },
      { id: "edit-run-verify", required: false, repeats: 3 },
      { id: "browser-terminal-task", required: false, repeats: 3 },
    ]
  );
});

test("recall capability accepts the battery's strict pass^3 completion without poisoning the report", () => {
  const index = CAPABILITIES.findIndex((capability) => capability.id === "cosine-recall-abstention");
  const capability = CAPABILITIES[index];
  assert.ok(capability);
  assert.equal(capability.repeats, RECALL_QUALITY_MIN_REPEAT);

  const row = classifyCapabilityResult(
    capability,
    result(completionLine({
      status: "passed",
      requested: RECALL_QUALITY_MIN_REPEAT,
      executed: RECALL_QUALITY_MIN_REPEAT,
    }))
  );
  assert.deepEqual(row, {
    id: "cosine-recall-abstention",
    required: true,
    status: "passed",
    requested: 3,
    executed: 3,
    durationMs: 17,
  });

  const rows = passingRows();
  rows[index] = row;
  const report = createCapabilityReport(rows);
  assert.equal(report.status, "passed");
  assert.equal(report.capabilities[index].status, "passed");
  assert.notEqual(report.capabilities[index].reason, "report-integrity-failed");
});

test("axis selector accepts exactly one known id and rejects empty, unknown, or duplicate selection", () => {
  assert.deepEqual(
    selectCapabilityAxes(["--axis", "plan-quality"]),
    { ok: true, axes: [CAPABILITIES[1]], selectedAxis: "plan-quality" }
  );
  assert.deepEqual(selectCapabilityAxes(["--axis"]), { ok: false, reason: "missing-axis-id" });
  assert.deepEqual(selectCapabilityAxes(["--axis", "--json"]), { ok: false, reason: "missing-axis-id" });
  assert.deepEqual(selectCapabilityAxes(["--axis", "not-an-axis"]), { ok: false, reason: "unknown-axis-id" });
  assert.deepEqual(
    selectCapabilityAxes(["--axis", "plan-quality", "--axis", "tool-selection-arguments"]),
    { ok: false, reason: "duplicate-axis-selection" }
  );
});

test("a shard receipt binds source, input, seed, model, and runtime without leaking environment values", () => {
  const capability = CAPABILITIES[0];
  const source = { revision: "a".repeat(40), tree: "clean" };
  const artifacts = { count: 41, digest: "b".repeat(64), status: "ok" };
  const provenance = {
    sourceBeforeBuild: source,
    sourceAfterBuild: source,
    sourceAtEnd: source,
    artifactsAfterBuild: artifacts,
    artifactsAtEnd: artifacts,
  };
  const env = {
    MUSE_EVAL_MODEL: "gemma4:12b",
    MUSE_EVAL_SEED: "17",
    MUSE_EVAL_THRESHOLD: "0.85",
    MUSE_EVAL_PRIVATE_FIXTURE: "top-secret-input",
  };
  const receipt = createCapabilityShardReceipt(capability, provenance, {
    env,
    nodeVersion: "v24.0.0",
    platformIdentity: "darwin/arm64",
  });
  assert.equal(receipt.axis, capability.id);
  assert.equal(receipt.seed, "17");
  assert.equal(receipt.source.revision, source.revision);
  assert.equal(receipt.source.tree, "clean");
  assert.equal(receipt.modelIdentity.generation, "gemma4:12b");
  assert.equal(receipt.runtimeIdentity.runnerArtifactDigest, artifacts.digest);
  assert.match(receipt.inputHash, /^[a-f0-9]{64}$/u);
  assert.doesNotMatch(JSON.stringify(receipt), /top-secret-input/u);

  const changed = createCapabilityShardReceipt(capability, provenance, {
    env: { ...env, MUSE_EVAL_THRESHOLD: "0.90" },
    nodeVersion: "v24.0.0",
    platformIdentity: "darwin/arm64",
  });
  assert.notEqual(changed.inputHash, receipt.inputHash);
  assert.equal(createCapabilityShardReceipt(capability, provenance, {
    env: { ...env, MUSE_EVAL_SEED: "unsafe seed value" },
  }), undefined);
  assert.equal(createCapabilityShardReceipt(capability, provenance, {
    env: { ...env, MUSE_EVAL_MODEL: "sk-secret-like-value" },
  }), undefined);
  assert.equal(createCapabilityShardReceipt(capability, {
    ...provenance,
    sourceBeforeBuild: { ...source, tree: "dirty" },
  }, { env }), undefined);
});

test("plan-quality threshold is pinned to one and cannot be weakened by environment", () => {
  const source = readFileSync(new URL("./eval-plan-quality.mjs", import.meta.url), "utf8");
  assert.match(source, /const THRESHOLD = 1;/u);
  assert.doesNotMatch(source, /process\.env\.MUSE_EVAL_THRESHOLD/u);
});

test("help is side-effect free and does not enter the expensive capability gate", () => {
  let stdout = "";
  let sideEffects = 0;
  const noSideEffects = () => {
    sideEffects += 1;
    throw new Error("help must not evaluate");
  };

  const report = main(["--help"], {
    buildRunnerArtifact: noSideEffects,
    captureArtifacts: noSideEffects,
    captureSource: noSideEffects,
    runTypeScriptBuild: noSideEffects,
    spawn: noSideEffects,
    stderr: { write: noSideEffects },
    stdout: { write: (chunk) => { stdout += chunk; } },
    writeReport: noSideEffects,
  });

  assert.equal(report, undefined);
  assert.equal(sideEffects, 0);
  assert.match(stdout, /Usage: pnpm eval:agent/u);
  assert.match(stdout, /may load local models/u);
});

test("short help is also side-effect free", () => {
  let sideEffects = 0;
  const report = main(["-h"], {
    captureSource: () => {
      sideEffects += 1;
      return { tree: "clean" };
    },
    stdout: { write: () => {} },
  });

  assert.equal(report, undefined);
  assert.equal(sideEffects, 0);
});

test("preflight is a static 11-axis plan and never enters the full evaluation pipeline", () => {
  let stdout = "";
  let sideEffects = 0;
  const noSideEffects = () => {
    sideEffects += 1;
    throw new Error("preflight must not evaluate");
  };

  const preflight = main(["--preflight"], {
    buildRunnerArtifact: noSideEffects,
    captureArtifacts: noSideEffects,
    captureSource: noSideEffects,
    runTypeScriptBuild: noSideEffects,
    spawn: noSideEffects,
    stderr: { write: noSideEffects },
    stdout: { write: (chunk) => { stdout += chunk; } },
    writeReport: noSideEffects,
  });

  assert.equal(sideEffects, 0);
  assert.equal(preflight.mode, "plan-only");
  assert.equal(preflight.qualification, "unverified");
  assert.equal(preflight.sideEffects, "none");
  assert.equal(preflight.axes.length, 11);
  assert.deepEqual(preflight.axes.map(({ id, repeats, required }) => ({ id, repeats, required })), CAPABILITIES.map(({ id, repeats, required }) => ({ id, repeats, required })));
  assert.deepEqual(preflight.resourceBudget, {
    batteryProcesses: 11,
    hardSequentialTimeoutMinutes: 132,
    perBatteryTimeoutMinutes: 12,
    requestedTrials: 31,
  });
  assert.match(stdout, /capability preflight \(plan only\)/u);
  assert.match(stdout, /qualification: UNVERIFIED/u);
  assert.doesNotMatch(stdout, /PASS|builds fresh artifacts/u);
});

test("preflight JSON is privacy-safe plan-only output and does not write a report", () => {
  let stdout = "";
  const noSideEffects = () => { throw new Error("preflight must not mutate"); };
  const preflight = main(["--preflight", "--json"], {
    buildRunnerArtifact: noSideEffects,
    captureArtifacts: noSideEffects,
    captureSource: noSideEffects,
    runTypeScriptBuild: noSideEffects,
    spawn: noSideEffects,
    stderr: { write: noSideEffects },
    stdout: { write: (chunk) => { stdout += chunk; } },
    writeReport: noSideEffects,
  });

  assert.deepEqual(JSON.parse(stdout), preflight);
  assert.equal(preflight.qualification, "unverified");
  assert.equal(Object.hasOwn(preflight, "provenance"), false);
  assert.doesNotMatch(stdout, /prompt|payload|private|secret/iu);
});

test("single-axis preflight selects exactly one known axis and uses only its budget", () => {
  let stdout = "";
  const noSideEffects = () => { throw new Error("single-axis preflight must not mutate"); };
  const preflight = main(["--preflight", "--axis", "plan-quality", "--json"], {
    beginAttempt: noSideEffects,
    buildRunnerArtifact: noSideEffects,
    captureArtifacts: noSideEffects,
    captureSource: noSideEffects,
    readResourceSnapshot: noSideEffects,
    runTypeScriptBuild: noSideEffects,
    spawn: noSideEffects,
    stdout: { write: (chunk) => { stdout += chunk; } },
  });
  assert.equal(preflight.axes.length, 1);
  assert.equal(preflight.axes[0].id, "plan-quality");
  assert.equal(preflight.resourceBudget.batteryProcesses, 1);
  assert.equal(preflight.resourceBudget.hardSequentialTimeoutMinutes, 12);
  assert.deepEqual(JSON.parse(stdout), preflight);
});

test("invalid axis selection fails before preflight build, spawn, or evidence writes", () => {
  let sideEffects = 0;
  const previousExitCode = process.exitCode;
  const noSideEffects = () => {
    sideEffects += 1;
    throw new Error("invalid axis must stop before side effects");
  };
  const cases = [
    { args: ["--preflight", "--axis", "--json"], reason: "missing-axis-id" },
    { args: ["--preflight", "--axis", "not-an-axis", "--json"], reason: "unknown-axis-id" },
    {
      args: ["--preflight", "--axis", "plan-quality", "--axis", "tool-selection-arguments", "--json"],
      reason: "duplicate-axis-selection",
    },
  ];
  for (const scenario of cases) {
    let stdout = "";
    const result = main(scenario.args, {
      beginAttempt: noSideEffects,
      buildRunnerArtifact: noSideEffects,
      captureArtifacts: noSideEffects,
      captureSource: noSideEffects,
      runTypeScriptBuild: noSideEffects,
      spawn: noSideEffects,
      stdout: { write: (chunk) => { stdout += chunk; } },
      writeReport: noSideEffects,
    });
    assert.equal(result.status, "defer");
    assert.deepEqual(result.reasons, [scenario.reason]);
    assert.deepEqual(JSON.parse(stdout), result);
  }
  process.exitCode = previousExitCode;
  assert.equal(sideEffects, 0);
});

test("single-axis execution runs only the selected battery and cannot pass the full aggregate", async () => {
  let stdout = "";
  let invocations = 0;
  const previousExitCode = process.exitCode;
  const report = await main(
    ["--json", "--execute", "--axis", "plan-quality", "--confirm-idle", "--budget-minutes", "12"],
    verifiedPipeline({
      spawn: (_command, _args, options) => {
        invocations += 1;
        const requested = Number(options.env.MUSE_EVAL_REPEAT);
        return {
          status: 0,
          signal: null,
          stdout: completionLine({ status: "passed", requested, executed: requested }),
          stderr: "",
        };
      },
      stdout: { write: (chunk) => { stdout += chunk; } },
      stderr: { write: () => {} },
    })
  );
  process.exitCode = previousExitCode;
  assert.equal(invocations, 1);
  assert.equal(report.status, "unverified");
  assert.deepEqual(report.counts, { passed: 1, failed: 0, unverified: 10, total: 11 });
  assert.equal(report.capabilities.find((row) => row.id === "plan-quality")?.status, "passed");
  assert.ok(
    report.capabilities
      .filter((row) => row.id !== "plan-quality")
      .every((row) => row.status === "unverified" && row.reason === "not-selected")
  );
  assert.deepEqual(JSON.parse(stdout), report);
});

test("single-axis execution skips the battery only for an exact reusable completed shard", async () => {
  let batteryInvocations = 0;
  let persistedOptions;
  const selected = CAPABILITIES.find((capability) => capability.id === "plan-quality");
  const cachedAxis = {
    durationMs: 123,
    executed: selected.repeats,
    id: selected.id,
    requested: selected.repeats,
    required: selected.required,
    status: "passed",
  };
  const previousExitCode = process.exitCode;
  const report = await main(
    ["--json", "--execute", "--axis", selected.id, "--confirm-idle", "--budget-minutes", "12"],
    verifiedPipeline({
      beginAttempt: () => ({ attemptId: "cache-hit" }),
      finishAttempt: (_attempt, current, options) => {
        persistedOptions = options;
        return current;
      },
      readReusableAxis: ({ axisId, expectedReceipt }) => ({
        axis: cachedAxis,
        generatedAt: "2026-07-21T00:00:00.000Z",
        matrixId: "muse-agent-capability-v2",
        provenance: {},
        schemaVersion: 2,
        shardReceipt: { ...expectedReceipt, axis: axisId },
      }),
      spawn: () => {
        batteryInvocations += 1;
        throw new Error("an exact cache hit must not launch the battery");
      },
      stderr: { write: () => {} },
      stdout: { write: () => {} },
    }),
  );
  process.exitCode = previousExitCode;
  assert.equal(batteryInvocations, 0);
  assert.equal(report.capabilities.find((row) => row.id === selected.id).status, "passed");
  assert.equal(persistedOptions.persistShardProgress, false);
});

test("the persisted aggregate is authoritative for JSON, human output, and exit status", async () => {
  const previousExitCode = process.exitCode;
  const run = async (json) => {
    let stdout = "";
    process.exitCode = undefined;
    const result = await main(
      [
        ...(json ? ["--json"] : []),
        "--execute",
        "--axis",
        "plan-quality",
        "--confirm-idle",
        "--budget-minutes",
        "12",
      ],
      verifiedPipeline({
        beginAttempt: () => ({ attemptId: "bounded-attempt" }),
        finishAttempt: (_attempt, current) => createCapabilityReport(
          current.capabilities.map((row) => row.id === "tool-selection-arguments"
            ? {
              durationMs: 10,
              executed: 3,
              id: "tool-selection-arguments",
              requested: 3,
              required: true,
              status: "passed",
            }
            : row),
          { generatedAt: current.generatedAt, provenance: current.provenance },
        ),
        now: () => 0,
        spawn: (_command, _args, options) => {
          const requested = Number(options.env.MUSE_EVAL_REPEAT);
          return {
            status: 0,
            signal: null,
            stdout: completionLine({ status: "passed", requested, executed: requested }),
            stderr: "",
          };
        },
        stdout: { write: (chunk) => { stdout += chunk; } },
        stderr: { write: () => {} },
      }),
    );
    return { result, stdout, exitCode: process.exitCode };
  };

  try {
    const json = await run(true);
    assert.deepEqual(json.result.counts, { passed: 2, failed: 0, unverified: 9, total: 11 });
    assert.deepEqual(JSON.parse(json.stdout), json.result);
    assert.equal(json.exitCode, 1);

    const human = await run(false);
    assert.deepEqual(human.result, json.result);
    assert.match(human.stdout, /eval:agent UNVERIFIED — 2 pass, 9 unverified, 0 fail/u);
    assert.equal(human.exitCode, 1);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test("the production evidence finalizer aggregate is accepted regardless of object key order", async () => {
  const root = mkdtempSync(join(tmpdir(), "muse-agent-production-finalizer-"));
  const canonicalReportPath = join(root, "evals", "agent-capability", "latest.json");
  const previousExitCode = process.exitCode;
  let stdout = "";
  try {
    process.exitCode = undefined;
    const result = await main(
      ["--json", "--execute", "--axis", "plan-quality", "--confirm-idle", "--budget-minutes", "12"],
      verifiedPipeline({
        beginAttempt: () => beginCapabilityEvidenceAttempt({
          allowedRoot: root,
          reportPath: canonicalReportPath,
        }),
        finishAttempt: (attempt, current, options) => finalizeCapabilityEvidenceAttempt(
          attempt,
          current,
          options,
        ),
        now: () => 0,
        spawn: (_command, _args, options) => {
          const requested = Number(options.env.MUSE_EVAL_REPEAT);
          return {
            status: 0,
            signal: null,
            stdout: completionLine({ status: "passed", requested, executed: requested }),
            stderr: "",
          };
        },
        stdout: { write: (chunk) => { stdout += chunk; } },
        stderr: { write: () => {} },
      }),
    );

    assert.deepEqual(result.counts, { failed: 0, passed: 1, total: 11, unverified: 10 });
    assert.deepEqual(JSON.parse(stdout), result);
    assert.deepEqual(
      inspectCapabilityEvidence({ allowedRoot: root, reportPath: canonicalReportPath }).artifact.value,
      result,
    );
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = previousExitCode;
    rmSync(root, { force: true, recursive: true });
  }
});

test("missing, malformed, or throwing finalization can never emit green", async () => {
  const previousExitCode = process.exitCode;
  const cases = [
    { name: "missing", finishAttempt: () => undefined },
    {
      name: "malformed",
      finishAttempt: (_attempt, current) => ({ ...current, privatePayload: "secret" }),
    },
    {
      name: "provenance-drift",
      finishAttempt: (_attempt, current) => {
        const source = { revision: "c".repeat(40), tree: "clean" };
        const artifacts = { count: 41, digest: "d".repeat(64), status: "ok" };
        return createCapabilityReport(passingRows(), {
          generatedAt: current.generatedAt,
          provenance: {
            sourceBeforeBuild: source,
            sourceAfterBuild: source,
            sourceAtEnd: source,
            artifactsAfterBuild: artifacts,
            artifactsAtEnd: artifacts,
          },
        });
      },
    },
    {
      name: "throwing",
      finishAttempt: () => { throw new Error("/Users/private-owner/finalize-failed"); },
    },
  ];
  try {
    for (const candidate of cases) {
      let stdout = "";
      process.exitCode = undefined;
      const result = await main(
        ["--json", "--execute", "--axis", "plan-quality", "--confirm-idle", "--budget-minutes", "12"],
        verifiedPipeline({
          beginAttempt: () => ({ attemptId: candidate.name }),
          finishAttempt: candidate.finishAttempt,
          now: () => 0,
          spawn: (_command, _args, options) => {
            const requested = Number(options.env.MUSE_EVAL_REPEAT);
            return {
              status: 0,
              signal: null,
              stdout: completionLine({ status: "passed", requested, executed: requested }),
              stderr: "",
            };
          },
          stdout: { write: (chunk) => { stdout += chunk; } },
          stderr: { write: () => {} },
        }),
      );
      assert.equal(result.status, "failed", candidate.name);
      assert.ok(
        result.capabilities.every((row) => row.reason === "report-persistence-failed"),
        candidate.name,
      );
      assert.deepEqual(JSON.parse(stdout), result, candidate.name);
      assert.doesNotMatch(stdout, /Users|private-owner|finalize-failed|privatePayload|secret/u);
      assert.equal(process.exitCode, 1, candidate.name);
    }
  } finally {
    process.exitCode = previousExitCode;
  }
});

test("preflight constructor remains a static manifest with no configured-machine readiness claim", () => {
  const preflight = createCapabilityPreflight();
  assert.equal(preflight.requiredBeforeRun.some((item) => item.includes("owner confirms")), true);
  assert.equal(preflight.axes.find((axis) => axis.id === "browser-terminal-task")?.requirements.includes("compatible-local-chrome"), true);
  assert.equal(preflight.axes.find((axis) => axis.id === "multihop-retrieval-lift")?.requirements.includes("local-ollama-embedding-model"), true);
  assert.equal(preflight.axes.find((axis) => axis.id === "computer-task-terminal-edit")?.requirements.includes("local-runner"), false);
});

test("execution admission is read-only, requires owner confirmation and a full declared budget", () => {
  let stdout = "";
  let sideEffects = 0;
  const previousExitCode = process.exitCode;
  const noSideEffects = () => {
    sideEffects += 1;
    throw new Error("admission must not evaluate");
  };
  try {
    process.exitCode = undefined;
    const refused = main(["--admit", "--json"], {
      buildRunnerArtifact: noSideEffects,
      captureArtifacts: noSideEffects,
      captureSource: noSideEffects,
      readResourceSnapshot: () => HEALTHY_RESOURCE_SNAPSHOT,
      runTypeScriptBuild: noSideEffects,
      spawn: noSideEffects,
      stdout: { write: (chunk) => { stdout += chunk; } },
      writeReport: noSideEffects,
    });

    assert.equal(sideEffects, 0);
    assert.equal(refused.mode, "execution-admission");
    assert.equal(refused.status, "defer");
    assert.deepEqual(refused.reasons, ["owner-idle-confirmation-required", "owner-budget-required"]);
    assert.deepEqual(JSON.parse(stdout), refused);

    const admitted = createCapabilityExecutionAdmissionForArgs(
      ["--admit", "--confirm-idle", "--budget-minutes", "132"],
      { readResourceSnapshot: () => HEALTHY_RESOURCE_SNAPSHOT }
    );
    assert.equal(admitted.status, "admit");
    assert.equal(admitted.sideEffects, "none");
  } finally {
    process.exitCode = previousExitCode;
  }
});

test("execution is refused before the build pipeline on missing intent, pressure, or invalid OS observations", () => {
  const scenarios = [
    { args: ["--json"], reason: "execution-intent-required", snapshot: HEALTHY_RESOURCE_SNAPSHOT },
    { args: ["--json", "--execute", "--confirm-idle", "--budget-minutes", "131"], reason: "insufficient-time-budget", snapshot: HEALTHY_RESOURCE_SNAPSHOT },
    { args: ["--json", "--execute", "--confirm-idle", "--budget-minutes", "1e100"], reason: "invalid-owner-budget", snapshot: HEALTHY_RESOURCE_SNAPSHOT },
    { args: ["--json", ...EXECUTE_ARGS], reason: "low-free-memory", snapshot: { ...HEALTHY_RESOURCE_SNAPSHOT, freeMemoryBytes: 1 } },
    { args: ["--json", ...EXECUTE_ARGS], reason: "cpu-load", snapshot: { ...HEALTHY_RESOURCE_SNAPSHOT, load1: 4 } },
    { args: ["--json", ...EXECUTE_ARGS], reason: "resource-observation-unavailable", snapshot: { ...HEALTHY_RESOURCE_SNAPSHOT, load1: Number.NaN } },
  ];
  const previousExitCode = process.exitCode;
  try {
    for (const scenario of scenarios) {
      let pipelineCalls = 0;
      const noPipeline = () => {
        pipelineCalls += 1;
        throw new Error("refused execution must not enter pipeline");
      };
      const admission = main(scenario.args, {
        buildRunnerArtifact: noPipeline,
        captureArtifacts: noPipeline,
        captureSource: noPipeline,
        readResourceSnapshot: () => scenario.snapshot,
        runTypeScriptBuild: noPipeline,
        spawn: noPipeline,
        stdout: { write: () => {} },
        writeReport: noPipeline,
      });
      assert.equal(admission.status, "defer");
      assert.ok(admission.reasons.includes(scenario.reason));
      assert.equal(pipelineCalls, 0);
    }
  } finally {
    process.exitCode = previousExitCode;
  }
});

test("a failing local counter is treated as unavailable and cannot start execution", () => {
  let pipelineCalls = 0;
  const previousExitCode = process.exitCode;
  const noPipeline = () => {
    pipelineCalls += 1;
    throw new Error("counter failure must not enter pipeline");
  };
  try {
    process.exitCode = undefined;
    const admission = main(["--json", ...EXECUTE_ARGS], {
      buildRunnerArtifact: noPipeline,
      captureArtifacts: noPipeline,
      captureSource: noPipeline,
      readResourceSnapshot: () => { throw new Error("counter unavailable"); },
      runTypeScriptBuild: noPipeline,
      spawn: noPipeline,
      stdout: { write: () => {} },
      writeReport: noPipeline,
    });
    assert.equal(admission.status, "defer");
    assert.ok(admission.reasons.includes("resource-observation-unavailable"));
    assert.equal(pipelineCalls, 0);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test("exit zero without explicit completion evidence fails closed", () => {
  assert.deepEqual(classifyCapabilityResult(stochastic, result("looks good\nPASS")), {
    id: stochastic.id,
    required: true,
    status: "failed",
    requested: 3,
    executed: 0,
    reason: "missing-completion",
    durationMs: 17,
  });
});

test("a capability passes only when the requested and executed repeat counts match", () => {
  const passed = completionLine({ status: "passed", requested: 3, executed: 3 });
  assert.equal(classifyCapabilityResult(stochastic, result(passed)).status, "passed");

  const wrongRequest = completionLine({ status: "passed", requested: 1, executed: 1 });
  assert.equal(classifyCapabilityResult(stochastic, result(wrongRequest)).reason, "requested-repeat-mismatch");
});

test("only a matching, recognized environmental skip can be unverified", () => {
  const completion = completionLine({
    status: "unverified",
    requested: 3,
    executed: 0,
    reason: "ollama-unreachable",
  });
  const recognized = `${skipLine("ollama-unreachable", "local provider down")}\n${completion}`;
  assert.equal(classifyCapabilityResult(stochastic, result(recognized)).status, "unverified");

  const unknown = `${skipLine("something-else", "not evidence")}\n${completion}`;
  assert.equal(classifyCapabilityResult(stochastic, result(unknown)).reason, "unrecognized-skip");

  const mismatch = `${skipLine("runner-missing", "not installed")}\n${completion}`;
  assert.equal(classifyCapabilityResult(stochastic, result(mismatch)).reason, "skip-reason-mismatch");

  for (const reason of ["chrome-missing", "model-missing"]) {
    const environmental = `${skipLine(reason, "preflight unavailable")}\n${completionLine({
      status: "unverified",
      requested: 3,
      executed: 0,
      reason,
    })}`;
    assert.equal(classifyCapabilityResult(stochastic, result(environmental)).status, "unverified");
  }
});

test("spawn errors, signals, non-zero exits, and contradictory pass markers fail", () => {
  const passed = completionLine({ status: "passed", requested: 3, executed: 3 });
  assert.equal(
    classifyCapabilityResult(stochastic, result("", { error: new Error("secret spawn details") })).reason,
    "spawn-error"
  );
  assert.equal(
    classifyCapabilityResult(stochastic, result("", { spawnError: true, status: null })).reason,
    "spawn-error"
  );
  assert.equal(
    classifyCapabilityResult(stochastic, result("", { status: null, timedOut: true })).reason,
    "evaluation-deadline-exhausted"
  );
  assert.equal(classifyCapabilityResult(stochastic, result("", { status: null, signal: "SIGTERM" })).reason, "signal");
  const nonZero = classifyCapabilityResult(stochastic, result(passed, { status: 2 }));
  assert.equal(nonZero.reason, "exit-nonzero");
  assert.equal(nonZero.executed, 3, "a real failed pass^k run must retain its executed-trial evidence");
  assert.equal(
    classifyCapabilityResult(stochastic, result(`${skipLine("ollama-unreachable")}\n${passed}`)).reason,
    "unexpected-skip"
  );
});

test("overall status considers every executed failure and JSON output contains no child payloads", () => {
  const rows = CAPABILITIES.map((capability) => ({
    id: capability.id,
    required: capability.required,
    status: capability.required ? "passed" : "unverified",
    requested: capability.repeats,
    executed: capability.required ? capability.repeats : 0,
    ...(capability.required ? {} : { reason: "runner-missing" }),
    durationMs: 11,
  }));
  const report = createCapabilityReport(rows);
  assert.equal(report.status, "passed");
  assert.deepEqual(report.counts, { passed: 9, failed: 0, unverified: 2, total: 11 });
  assert.deepEqual(Object.keys(report), [
    "version",
    "matrixId",
    "generatedAt",
    "status",
    "counts",
    "capabilities",
    "provenance",
  ]);

  const encoded = JSON.stringify(report);
  assert.doesNotMatch(encoded, /prompt|output|payload|secret spawn details/iu);

  rows[0] = { ...rows[0], status: "unverified", executed: 0, reason: "ollama-unreachable" };
  assert.equal(createCapabilityReport(rows).status, "unverified");
  rows[1] = { ...rows[1], status: "failed", executed: 0, reason: "missing-completion" };
  assert.equal(createCapabilityReport(rows).status, "failed");

  const optional = CAPABILITIES.findIndex((capability) => !capability.required);
  const otherwisePassing = CAPABILITIES.map((capability) => ({
    id: capability.id,
    required: capability.required,
    status: "passed",
    requested: capability.repeats,
    executed: capability.repeats,
    durationMs: 1,
  }));
  otherwisePassing[optional] = {
    ...otherwisePassing[optional],
    status: "failed",
    reason: "terminal-state-failed",
  };
  assert.equal(createCapabilityReport(otherwisePassing).status, "failed");
});

test("report creation fails closed on canonical matrix omission, duplication, or field mutation", () => {
  const valid = passingRows();
  const mutations = [
    valid.slice(1),
    [...valid, valid[0]],
    valid.map((row, index) => index === 0 ? { ...row, required: false } : row),
    valid.map((row, index) => index === 0 ? { ...row, requested: 1 } : row),
    valid.map((row, index) => index === 0 ? { ...row, executed: 0 } : row),
    valid.map((row, index) => index === 0 ? { ...row, privatePath: "/Users/private-owner" } : row),
    valid.map((row, index) => index === 0
      ? { ...row, executed: 0, reason: "private-owner-name", status: "failed" }
      : row),
  ];

  for (const rows of mutations) {
    const report = createCapabilityReport(rows);
    assert.equal(report.status, "failed");
    assert.equal(report.capabilities.length, CAPABILITIES.length);
    assert.ok(report.capabilities.every((row) => row.reason === "report-integrity-failed"));
  }
});

test("marker mutation: fail and environmental skip cannot be mistaken for pass", () => {
  const failed = completionLine({ status: "failed", requested: 3, executed: 3, reason: "threshold-not-met" });
  assert.equal(classifyCapabilityResult(stochastic, result(failed)).status, "failed");

  const skipped = `${skipLine("model-missing", "model not installed")}\n${completionLine({
    status: "unverified",
    requested: 3,
    executed: 0,
    reason: "model-missing",
  })}`;
  assert.equal(classifyCapabilityResult(stochastic, result(skipped)).status, "unverified");
  assert.equal(
    classifyCapabilityResult(stochastic, result(skipped.replace('"status":"unverified"', '"status":"passed"'))).status,
    "failed"
  );
});

test("--json keeps stdout JSON-only, redirects safe progress, and enforces repeat env", async () => {
  let stdout = "";
  let stderr = "";
  let clock = 0;
  const repeats = [];
  const deadlines = [];
  const fakeRunProcess = (_command, _args, options) => {
    const requested = Number(options.env.MUSE_EVAL_REPEAT);
    repeats.push(requested);
    deadlines.push(options.deadlineMs);
    return {
      status: 0,
      signal: null,
      stdout: `${completionLine({ status: "passed", requested, executed: requested })}\nPRIVATE_CHILD_PAYLOAD`,
      stderr: "PRIVATE_CHILD_ERROR",
    };
  };

  const report = await main(["--json", ...EXECUTE_ARGS], verifiedPipeline({
    runProcess: fakeRunProcess,
    stdout: { write: (chunk) => { stdout += chunk; } },
    stderr: { write: (chunk) => { stderr += chunk; } },
    now: () => clock++,
  }));

  assert.deepEqual(JSON.parse(stdout), report);
  assert.deepEqual(repeats, [3, 3, 3, 3, 3, 3, 1, 3, 3, 3, 3]);
  assert.equal(deadlines.length, CAPABILITIES.length);
  assert.ok(deadlines.every((deadline) => deadline === 12 * 60 * 1000));
  assert.doesNotMatch(stdout, /PRIVATE_CHILD|eval:agent running/u);
  assert.doesNotMatch(stderr, /PRIVATE_CHILD/u);
  assert.match(stderr, /eval:agent running tool-selection-arguments/u);
});

test("an async process-runner rejection becomes terminal privacy-safe spawn failure evidence", async () => {
  let stdout = "";
  const previousExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const report = await main(
      ["--json", "--execute", "--axis", "plan-quality", "--confirm-idle", "--budget-minutes", "12"],
      verifiedPipeline({
        runProcess: async () => {
          throw new Error("/Users/private-owner/process-control-failed");
        },
        stderr: { write: () => {} },
        stdout: { write: (chunk) => { stdout += chunk; } },
      })
    );

    const row = report.capabilities.find((capability) => capability.id === "plan-quality");
    assert.equal(row?.status, "failed");
    assert.equal(row?.reason, "spawn-error");
    assert.equal(process.exitCode, 1);
    assert.deepEqual(JSON.parse(stdout), report);
    assert.doesNotMatch(stdout, /Users|private-owner|process-control-failed/u);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test("a single axis shares one 12-minute deadline across source, builds, and battery", async () => {
  let elapsedMs = 0;
  const deadlines = [];
  const source = { revision: "a".repeat(40), tree: "clean" };
  const artifact = { count: 41, digest: "a".repeat(64), status: "ok" };
  const previousExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const report = await main(
      ["--json", "--execute", "--axis", "plan-quality", "--confirm-idle", "--budget-minutes", "12"],
      {
        buildRunnerArtifact: async ({ deadlineMs }) => {
          deadlines.push(["cargo", deadlineMs]);
          elapsedMs += 4 * 60_000;
          return { ok: true, runnerPath: "/fixed/private/muse-runner" };
        },
        captureArtifacts: () => artifact,
        captureSource: async ({ deadlineMs }) => {
          deadlines.push(["source", deadlineMs]);
          if (deadlines.length === 1) elapsedMs += 60_000;
          return source;
        },
        monotonicNow: () => elapsedMs,
        readResourceSnapshot: () => HEALTHY_RESOURCE_SNAPSHOT,
        runProcess: async (_command, _args, options) => {
          deadlines.push(["battery", options.deadlineMs]);
          return {
            signal: null,
            status: 0,
            stderr: "",
            stdout: completionLine({ executed: 3, requested: 3, status: "passed" }),
          };
        },
        runTypeScriptBuild: async ({ deadlineMs }) => {
          deadlines.push(["typescript", deadlineMs]);
          elapsedMs += 3 * 60_000;
          return { ok: true };
        },
        stderr: { write: () => {} },
        stdout: { write: () => {} },
      },
    );

    assert.deepEqual(deadlines, [
      ["source", 12 * 60_000],
      ["typescript", 11 * 60_000],
      ["cargo", 8 * 60_000],
      ["source", 4 * 60_000],
      ["battery", 4 * 60_000],
      ["source", 4 * 60_000],
    ]);
    assert.equal(report.capabilities.find((row) => row.id === "plan-quality")?.status, "passed");
  } finally {
    process.exitCode = previousExitCode;
  }
});

test("exhausting the shared deadline before a build fails closed without launching it or a battery", async () => {
  let elapsedMs = 0;
  let buildCalls = 0;
  let batteryCalls = 0;
  let stdout = "";
  const previousExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const report = await main(
      ["--json", "--execute", "--axis", "plan-quality", "--confirm-idle", "--budget-minutes", "12"],
      {
        buildRunnerArtifact: async () => {
          buildCalls += 1;
          return { ok: true, runnerPath: "/fixed/private/muse-runner" };
        },
        captureArtifacts: () => ({ count: 41, digest: "a".repeat(64), status: "ok" }),
        captureSource: async () => {
          elapsedMs = 12 * 60_000;
          return { revision: "a".repeat(40), tree: "clean" };
        },
        monotonicNow: () => elapsedMs,
        readResourceSnapshot: () => HEALTHY_RESOURCE_SNAPSHOT,
        runProcess: async () => {
          batteryCalls += 1;
          throw new Error("battery must not run after deadline exhaustion");
        },
        runTypeScriptBuild: async () => {
          buildCalls += 1;
          return { ok: true };
        },
        stderr: { write: () => {} },
        stdout: { write: (chunk) => { stdout += chunk; } },
      },
    );

    assert.equal(report.status, "failed");
    assert.equal(buildCalls, 0);
    assert.equal(batteryCalls, 0);
    assert.ok(report.capabilities.every((row) => (
      row.reason === "evaluation-deadline-exhausted" || row.reason === "not-selected"
    )));
    assert.deepEqual(JSON.parse(stdout), report);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test("an async build rejection records only the stable path-free build reason", async () => {
  let stdout = "";
  let batteryCalls = 0;
  const previousExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const report = await main(
      ["--json", "--execute", "--axis", "plan-quality", "--confirm-idle", "--budget-minutes", "12"],
      verifiedPipeline({
        runProcess: async () => {
          batteryCalls += 1;
          throw new Error("battery must not run after build rejection");
        },
        runTypeScriptBuild: async () => {
          throw new Error("/Users/private-owner/secret-build-path");
        },
        stderr: { write: () => {} },
        stdout: { write: (chunk) => { stdout += chunk; } },
      }),
    );

    assert.equal(report.status, "failed");
    assert.equal(batteryCalls, 0);
    assert.ok(report.capabilities.every((row) => (
      row.reason === "typescript-build-failed" || row.reason === "not-selected"
    )));
    assert.doesNotMatch(stdout, /Users|private-owner|secret-build-path/u);
    assert.deepEqual(JSON.parse(stdout), report);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test("default orchestration binds every battery to one freshly built source and runner artifact", async () => {
  const order = [];
  const runnerPaths = [];
  const sourceSnapshots = [
    { revision: "a".repeat(40), tree: "clean" },
    { revision: "a".repeat(40), tree: "clean" },
    { revision: "a".repeat(40), tree: "clean" },
  ];
  const artifactSnapshots = [
    { count: 41, digest: "a".repeat(64), status: "ok" },
    { count: 41, digest: "a".repeat(64), status: "ok" },
  ];

  const report = await main(["--json", ...EXECUTE_ARGS], {
    buildRunnerArtifact: () => {
      order.push("runner-build");
      return { ok: true, runnerPath: "/fixed/private/muse-runner" };
    },
    captureArtifacts: () => {
      order.push("artifacts");
      return artifactSnapshots.shift();
    },
    captureSource: () => {
      order.push("source");
      return sourceSnapshots.shift();
    },
    readResourceSnapshot: () => HEALTHY_RESOURCE_SNAPSHOT,
    now: () => 0,
    runTypeScriptBuild: () => {
      order.push("typescript-build");
      return { ok: true };
    },
    spawn: (_command, _args, options) => {
      order.push("battery");
      runnerPaths.push(options.env.MUSE_RUNNER_PATH);
      const requested = Number(options.env.MUSE_EVAL_REPEAT);
      return {
        signal: null,
        status: 0,
        stderr: "",
        stdout: completionLine({ executed: requested, requested, status: "passed" }),
      };
    },
    stderr: { write: () => {} },
    stdout: { write: () => {} },
  });

  assert.deepEqual(order, [
    "source",
    "typescript-build",
    "runner-build",
    "source",
    "artifacts",
    ...Array(CAPABILITIES.length).fill("battery"),
    "source",
    "artifacts",
  ]);
  assert.deepEqual(runnerPaths, Array(CAPABILITIES.length).fill("/fixed/private/muse-runner"));
  assert.equal(report.version, 2);
  assert.equal(report.matrixId, "muse-agent-capability-v2");
  assert.deepEqual(Object.keys(report.provenance), [
    "sourceBeforeBuild",
    "sourceAfterBuild",
    "sourceAtEnd",
    "artifactsAfterBuild",
    "artifactsAtEnd",
  ]);
  assert.deepEqual(report.provenance, {
    sourceBeforeBuild: { revision: "a".repeat(40), tree: "clean" },
    sourceAfterBuild: { revision: "a".repeat(40), tree: "clean" },
    sourceAtEnd: { revision: "a".repeat(40), tree: "clean" },
    artifactsAfterBuild: { count: 41, digest: "a".repeat(64), status: "ok" },
    artifactsAtEnd: { count: 41, digest: "a".repeat(64), status: "ok" },
  });
});

test("a failed forced TypeScript build records a terminal failed attempt without replacing prior canonical evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "muse-agent-build-failure-"));
  const reportPath = join(dir, "latest.json");
  writeOwnerJson(reportPath, { status: "passed", version: 1 });
  const previousExitCode = process.exitCode;
  let artifactReads = 0;
  let batteryRuns = 0;
  try {
    process.exitCode = undefined;
    const report = await main(["--json", ...EXECUTE_ARGS], {
      buildRunnerArtifact: () => {
        throw new Error("runner build must not run after TypeScript failure");
      },
      captureArtifacts: () => {
        artifactReads += 1;
        return { count: 99, digest: "b".repeat(64), status: "ok" };
      },
      captureSource: () => ({ revision: "a".repeat(40), tree: "clean" }),
      readResourceSnapshot: () => HEALTHY_RESOURCE_SNAPSHOT,
      now: () => 0,
      runTypeScriptBuild: () => ({ ok: false, reason: "typescript-build-failed" }),
      spawn: () => {
        batteryRuns += 1;
        throw new Error("battery must not run after build failure");
      },
      stderr: { write: () => {} },
      stdout: { write: () => {} },
      writeReport: (value) => persistCapabilityReport(value, reportPath, { allowedRoot: dir }),
    });

    assert.equal(report.status, "failed");
    assert.ok(report.capabilities.every((row) => row.reason === "typescript-build-failed"));
    assert.deepEqual(report.provenance.artifactsAfterBuild, { count: 0, status: "unknown" });
    assert.deepEqual(report.provenance.artifactsAtEnd, { count: 0, status: "unknown" });
    assert.equal(artifactReads, 0);
    assert.equal(batteryRuns, 0);
    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), { status: "passed", version: 1 });
    assert.equal(inspectCapabilityEvidence({ allowedRoot: dir, reportPath }).status, "failed");
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = previousExitCode;
    rmSync(dir, { force: true, recursive: true });
  }
});

test("source drift or runtime artifact mutation cannot retain a passing report", async () => {
  const previousExitCode = process.exitCode;
  const run = ({ artifacts, sources }) => main(["--json", ...EXECUTE_ARGS], verifiedPipeline({
    captureArtifacts: () => artifacts.shift(),
    captureSource: () => sources.shift(),
    now: () => 0,
    spawn: (_command, _args, options) => {
      const requested = Number(options.env.MUSE_EVAL_REPEAT);
      return {
        signal: null,
        status: 0,
        stderr: "",
        stdout: completionLine({ executed: requested, requested, status: "passed" }),
      };
    },
    stderr: { write: () => {} },
    stdout: { write: () => {} },
  }));

  try {
    process.exitCode = undefined;
    const sourceDrift = await run({
      artifacts: [
        { count: 41, digest: "a".repeat(64), status: "ok" },
        { count: 41, digest: "a".repeat(64), status: "ok" },
      ],
      sources: [
        { revision: "a".repeat(40), tree: "clean" },
        { revision: "a".repeat(40), tree: "clean" },
        { revision: "b".repeat(40), tree: "clean" },
      ],
    });
    assert.equal(sourceDrift.status, "unverified");
    assert.ok(sourceDrift.capabilities.every((row) => row.reason === "source-provenance-unverified"));

    process.exitCode = undefined;
    const artifactMutation = await run({
      artifacts: [
        { count: 41, digest: "a".repeat(64), status: "ok" },
        { count: 41, digest: "b".repeat(64), status: "ok" },
      ],
      sources: [
        { revision: "c".repeat(40), tree: "clean" },
        { revision: "c".repeat(40), tree: "clean" },
        { revision: "c".repeat(40), tree: "clean" },
      ],
    });
    assert.equal(artifactMutation.status, "unverified");
    assert.ok(artifactMutation.capabilities.every((row) => row.reason === "artifact-provenance-unverified"));
  } finally {
    process.exitCode = previousExitCode;
  }
});

test("invalid source and artifact probe payloads are reduced to path-free unknown provenance", async () => {
  const previousExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const report = await main(["--json", ...EXECUTE_ARGS], verifiedPipeline({
      captureArtifacts: () => ({
        count: 1,
        digest: "/Users/private-owner/secret-runner",
        status: "ok",
      }),
      captureSource: () => ({
        revision: "/Users/private-owner/worktree",
        tree: "clean",
      }),
      now: () => 0,
      spawn: (_command, _args, options) => {
        const requested = Number(options.env.MUSE_EVAL_REPEAT);
        return {
          signal: null,
          status: 0,
          stderr: "",
          stdout: completionLine({ executed: requested, requested, status: "passed" }),
        };
      },
      stderr: { write: () => {} },
      stdout: { write: () => {} },
    }));

    const encoded = JSON.stringify(report);
    assert.doesNotMatch(encoded, /Users|private-owner|secret-runner|worktree/u);
    assert.deepEqual(report.provenance.sourceBeforeBuild, { tree: "unknown" });
    assert.deepEqual(report.provenance.artifactsAfterBuild, { count: 0, status: "unknown" });
  } finally {
    process.exitCode = previousExitCode;
  }
});

test("privacy-safe aggregate evidence is persisted atomically with owner-only permissions", () => {
  const dir = mkdtempSync(join(tmpdir(), "muse-agent-report-"));
  const reportPath = join(dir, "nested", "latest.json");
  const report = passingReport();
  persistCapabilityReport(report, reportPath, { allowedRoot: dir });

  assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), report);
  assert.equal(statSync(reportPath).mode & 0o777, 0o600);
  assert.equal(statSync(join(dir, "nested")).mode & 0o077, 0);
});

test("report persistence rejects parent symlink redirects without touching external state", () => {
  const allowedRoot = mkdtempSync(join(tmpdir(), "muse-agent-report-root-"));
  const outside = mkdtempSync(join(tmpdir(), "muse-agent-report-outside-"));
  const externalReport = join(outside, "latest.json");
  const reportPath = join(allowedRoot, "redirect", "latest.json");
  try {
    writeFileSync(externalReport, "external sentinel", "utf8");
    symlinkSync(outside, join(allowedRoot, "redirect"), process.platform === "win32" ? "junction" : "dir");

    assert.throws(
      () => persistCapabilityReport(passingReport(), reportPath, { allowedRoot }),
      (error) => error instanceof Error && error.message === "capability-report-persistence-failed",
    );
    assert.equal(readFileSync(externalReport, "utf8"), "external sentinel");
  } finally {
    rmSync(allowedRoot, { force: true, recursive: true });
    rmSync(outside, { force: true, recursive: true });
  }
});

test("a failed canonical replace preserves the prior pass while the current attempt remains running", async () => {
  const allowedRoot = mkdtempSync(join(tmpdir(), "muse-agent-report-failure-"));
  const reportPath = join(allowedRoot, "nested", "latest.json");
  mkdirSync(join(allowedRoot, "nested"), { recursive: true });
  const prior = { status: "passed", version: 2 };
  writeOwnerJson(reportPath, prior);
  try {
    let renames = 0;
    assert.throws(
      () => persistCapabilityReport(passingReport(), reportPath, {
        allowedRoot,
        rename: (from, to) => {
          renames += 1;
          if (renames === 4) throw new Error("/Users/private-owner/rename-failed");
          renameSync(from, to);
        },
      }),
      (error) => error instanceof Error && error.message === "capability-report-persistence-failed",
    );
    assert.deepEqual(JSON.parse(readFileSync(reportPath, "utf8")), prior);
    assert.equal(inspectCapabilityEvidence({ allowedRoot, reportPath }).state, "running");

    let stdout = "";
    const previousExitCode = process.exitCode;
    try {
      process.exitCode = undefined;
      const report = await main(["--json", ...EXECUTE_ARGS], verifiedPipeline({
        now: () => 0,
        spawn: (_command, _args, options) => {
          const requested = Number(options.env.MUSE_EVAL_REPEAT);
          return {
            signal: null,
            status: 0,
            stderr: "",
            stdout: completionLine({ executed: requested, requested, status: "passed" }),
          };
        },
        stderr: { write: () => {} },
        stdout: { write: (chunk) => { stdout += chunk; } },
        writeReport: () => { throw new Error("/Users/private-owner/report-path"); },
      }));
      assert.equal(report.status, "failed");
      assert.ok(report.capabilities.every((row) => row.reason === "report-persistence-failed"));
      assert.deepEqual(JSON.parse(stdout), report);
      assert.doesNotMatch(stdout, /Users|private-owner|report-path/u);
      assert.equal(process.exitCode, 1);
    } finally {
      process.exitCode = previousExitCode;
    }
  } finally {
    rmSync(allowedRoot, { force: true, recursive: true });
  }
});

test("a required environmental skip makes the strict aggregate process exit nonzero", async () => {
  let stdout = "";
  let invocation = 0;
  const previousExitCode = process.exitCode;
  try {
    process.exitCode = undefined;
    const report = await main(["--json", ...EXECUTE_ARGS], verifiedPipeline({
      spawn: (_command, _args, options) => {
        const capability = CAPABILITIES[invocation++];
        assert.ok(capability);
        const requested = Number(options.env.MUSE_EVAL_REPEAT);
        const completion = capability.id === "tool-selection-arguments"
          ? `${skipLine("ollama-unreachable", "local provider down")}\n${completionLine({
              status: "unverified",
              requested,
              executed: 0,
              reason: "ollama-unreachable",
            })}`
          : completionLine({ status: "passed", requested, executed: requested });
        return { signal: null, status: 0, stderr: "", stdout: completion };
      },
      stdout: { write: (chunk) => { stdout += chunk; } },
      stderr: { write: () => {} },
      now: () => 0,
    }));

    assert.equal(report.status, "unverified");
    assert.equal(JSON.parse(stdout).status, "unverified");
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = previousExitCode;
  }
});
